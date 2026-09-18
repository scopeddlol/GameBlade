/**
 * An LZMA1 decoder, just large enough to read a 7z archive's header.
 *
 * Why this exists at all: a `.7z` keeps its file list — names, sizes, which
 * entries are folders — in a header that 7-Zip compresses by default, so
 * listing what is inside one means decompressing something before any of it
 * can be read. Node ships zlib and brotli and nothing that speaks LZMA, and
 * the alternatives were a native addon (which would have to build on Alpine
 * musl for three Docker targets) or shelling out to a `7z` binary the server
 * cannot assume is installed. Six hundred lines that depend on nothing beat
 * both.
 *
 * What it is *not* is a general-purpose LZMA implementation. It decodes a raw
 * LZMA1 stream whose properties and output length are already known — which is
 * exactly how 7z stores a coder's stream, and nothing like the `.lzma` or `.xz`
 * container formats. There is no encoder, no streaming interface and no
 * dictionary window: the caller knows the output size up front, so the output
 * buffer *is* the dictionary and a match simply reads back into it.
 *
 * It is only ever pointed at a header, never at game data. Headers are
 * kilobytes, which is what makes decoding straight into one buffer reasonable,
 * and `MAX_OUTPUT_BYTES` keeps a corrupt or hostile size field from asking for
 * a gigabyte before anything has been decoded.
 *
 * The algorithm is the reference decoder's, structured the same way so the two
 * can be read side by side: a range decoder over bit probabilities, a state
 * machine choosing between literals and matches, and four rolling distances.
 */

/** The largest header this will decode, before it stops rather than allocates. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Probabilities are 11-bit, adapted by a fifth of the distance to the bound. */
const PROB_BITS = 11;
const PROB_INIT = (1 << PROB_BITS) >>> 1;
const MOVE_BITS = 5;

/** The range decoder renormalises whenever the range drops below 2^24. */
const TOP_VALUE = 1 << 24;

const STATE_COUNT = 12;
const POS_STATES_MAX = 16;
const MATCH_MIN_LEN = 2;
const LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const ALIGN_BITS = 4;

export class LzmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LzmaError';
  }
}

/**
 * A range decoder reading bits whose probabilities adapt as it goes.
 *
 * `range` and `code` are 32-bit unsigned quantities held in JavaScript
 * numbers: every operation that could set the top bit is forced back through
 * `>>> 0`, because a signed 32-bit `code` compares wrongly against `bound` and
 * the failure looks like corrupt data rather than a bug.
 */
class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private position: number;

  constructor(
    private readonly input: Uint8Array,
    start: number,
  ) {
    this.position = start;

    // The first byte of a stream is padding and must be zero; the next four
    // are the initial code, big-endian.
    if (this.position + 5 > input.length) {
      throw new LzmaError('The compressed stream is too short to start');
    }
    if (input[this.position] !== 0) {
      throw new LzmaError('The compressed stream does not begin with a range coder byte');
    }
    this.position += 1;
    for (let index = 0; index < 4; index += 1) {
      this.code = ((this.code << 8) | input[this.position]!) >>> 0;
      this.position += 1;
    }
  }

  private nextByte(): number {
    // Running past the end is how a truncated stream presents. Feeding zeroes
    // would decode plausible-looking rubbish instead of failing here.
    if (this.position >= this.input.length) {
      throw new LzmaError('The compressed stream ended early');
    }
    const value = this.input[this.position]!;
    this.position += 1;
    return value;
  }

  private normalize(): void {
    if (this.range < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.nextByte()) >>> 0;
    }
  }

  /** One bit with an adapting probability, which this updates in place. */
  decodeBit(probs: Uint16Array, index: number): number {
    const probability = probs[index]!;
    // `range >>> PROB_BITS` is below 2^21 and a probability below 2^11, so the
    // product stays under 2^32 and is exact as a double.
    const bound = (this.range >>> PROB_BITS) * probability;

    if (this.code >>> 0 < bound) {
      probs[index] = probability + (((1 << PROB_BITS) - probability) >>> MOVE_BITS);
      this.range = bound >>> 0;
      this.normalize();
      return 0;
    }

    probs[index] = probability - (probability >>> MOVE_BITS);
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    this.normalize();
    return 1;
  }

  /** Bits with no model behind them, used for the high part of a distance. */
  decodeDirectBits(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      const sign = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & sign)) >>> 0;
      if (this.code === this.range) {
        throw new LzmaError('The compressed stream is corrupt');
      }
      this.normalize();
      result = ((result << 1) + (sign + 1)) >>> 0;
    }
    return result;
  }

  /** True once the decoder has consumed exactly the stream it was given. */
  isFinished(): boolean {
    return this.code === 0;
  }
}

function newProbs(size: number): Uint16Array {
  return new Uint16Array(size).fill(PROB_INIT);
}

function bitTreeDecode(
  decoder: RangeDecoder,
  probs: Uint16Array,
  offset: number,
  bits: number,
): number {
  let model = 1;
  for (let index = 0; index < bits; index += 1) {
    model = (model << 1) + decoder.decodeBit(probs, offset + model);
  }
  return model - (1 << bits);
}

function bitTreeReverseDecode(
  decoder: RangeDecoder,
  probs: Uint16Array,
  offset: number,
  bits: number,
): number {
  let model = 1;
  let symbol = 0;
  for (let index = 0; index < bits; index += 1) {
    const bit = decoder.decodeBit(probs, offset + model);
    model = (model << 1) + bit;
    symbol |= bit << index;
  }
  return symbol;
}

/**
 * Match lengths: a three-way choice between a short, a medium and a long
 * length, each decoded from its own bit tree.
 */
class LengthDecoder {
  private readonly choice = newProbs(2);
  private readonly low = newProbs(POS_STATES_MAX << 3);
  private readonly mid = newProbs(POS_STATES_MAX << 3);
  private readonly high = newProbs(1 << 8);

  decode(decoder: RangeDecoder, posState: number): number {
    if (decoder.decodeBit(this.choice, 0) === 0) {
      return bitTreeDecode(decoder, this.low, posState << 3, 3);
    }
    if (decoder.decodeBit(this.choice, 1) === 0) {
      return 8 + bitTreeDecode(decoder, this.mid, posState << 3, 3);
    }
    return 16 + bitTreeDecode(decoder, this.high, 0, 8);
  }
}

/** The three numbers packed into an LZMA properties byte, plus the dictionary. */
export interface LzmaProperties {
  /** Literal context bits: how much of the previous byte selects the model. */
  lc: number;
  /** Literal position bits. */
  lp: number;
  /** Position bits: how much of the output position selects the model. */
  pb: number;
  dictionarySize: number;
}

/**
 * Unpacks the five-byte coder properties 7z stores beside a stream.
 *
 * The first byte packs all three counts into one number, which is why an
 * invalid archive most often shows up as an `lc` of 9 rather than as anything
 * that looks like a broken file.
 */
export function readLzmaProperties(properties: Uint8Array): LzmaProperties {
  if (properties.length < 5) {
    throw new LzmaError('LZMA properties are too short');
  }

  let packed = properties[0]!;
  if (packed >= 9 * 5 * 5) {
    throw new LzmaError('LZMA properties are out of range');
  }

  const lc = packed % 9;
  packed = (packed - lc) / 9;
  const lp = packed % 5;
  const pb = (packed - lp) / 5;

  const dictionarySize =
    (properties[1]! | (properties[2]! << 8) | (properties[3]! << 16) | (properties[4]! << 24)) >>>
    0;

  return { lc, lp, pb, dictionarySize };
}

/**
 * Decodes one raw LZMA1 stream of known length.
 *
 * `outputSize` is not a hint: 7z records the exact unpacked size of every
 * stream, and decoding stops there rather than at an end marker, which many
 * 7z streams do not carry.
 */
export function lzmaDecode(
  input: Uint8Array,
  properties: LzmaProperties,
  outputSize: number,
): Uint8Array {
  if (outputSize < 0 || outputSize > MAX_OUTPUT_BYTES) {
    throw new LzmaError(`Refusing to decode ${outputSize} bytes of LZMA`);
  }

  const { lc, lp, pb } = properties;
  const output = new Uint8Array(outputSize);
  if (outputSize === 0) return output;

  const decoder = new RangeDecoder(input, 0);

  const literalProbs = newProbs(0x300 << (lc + lp));
  const isMatch = newProbs(STATE_COUNT << 4);
  const isRep = newProbs(STATE_COUNT);
  const isRepG0 = newProbs(STATE_COUNT);
  const isRepG1 = newProbs(STATE_COUNT);
  const isRepG2 = newProbs(STATE_COUNT);
  const isRep0Long = newProbs(STATE_COUNT << 4);
  const posSlotProbs = newProbs(LEN_TO_POS_STATES << 6);
  const specPosProbs = newProbs(FULL_DISTANCES - END_POS_MODEL_INDEX);
  const alignProbs = newProbs(1 << ALIGN_BITS);
  const lengths = new LengthDecoder();
  const repLengths = new LengthDecoder();

  const posMask = (1 << pb) - 1;
  const literalPosMask = (1 << lp) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let position = 0;

  while (position < outputSize) {
    const posState = position & posMask;

    if (decoder.decodeBit(isMatch, (state << 4) + posState) === 0) {
      /* ------------------------------------------------------------ literal */
      const previous = position > 0 ? output[position - 1]! : 0;
      const literalState = ((position & literalPosMask) << lc) + (previous >>> (8 - lc));
      const base = 0x300 * literalState;
      let symbol = 1;

      if (state >= 7) {
        // After a match the byte at the same offset in the previous match is
        // a strong predictor, so it selects the model until the two diverge.
        let matched = output[position - rep0 - 1]!;
        do {
          const matchBit = (matched >>> 7) & 1;
          matched = (matched << 1) & 0xff;
          const bit = decoder.decodeBit(literalProbs, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) {
            while (symbol < 0x100) {
              symbol = (symbol << 1) | decoder.decodeBit(literalProbs, base + symbol);
            }
            break;
          }
        } while (symbol < 0x100);
      } else {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decoder.decodeBit(literalProbs, base + symbol);
        }
      }

      output[position] = symbol & 0xff;
      position += 1;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    /* -------------------------------------------------------------- match */
    let length: number;

    if (decoder.decodeBit(isRep, state) !== 0) {
      // A repeat of one of the last four distances.
      if (position === 0) {
        throw new LzmaError('The compressed stream repeats a match before any output');
      }
      if (decoder.decodeBit(isRepG0, state) === 0) {
        if (decoder.decodeBit(isRep0Long, (state << 4) + posState) === 0) {
          // The one-byte case, common enough to have its own encoding.
          state = state < 7 ? 9 : 11;
          output[position] = output[position - rep0 - 1]!;
          position += 1;
          continue;
        }
      } else {
        let distance: number;
        if (decoder.decodeBit(isRepG1, state) === 0) {
          distance = rep1;
        } else {
          if (decoder.decodeBit(isRepG2, state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }

      length = repLengths.decode(decoder, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;

      length = lengths.decode(decoder, posState);
      state = state < 7 ? 7 : 10;

      // The distance's model depends on how long the match is, short matches
      // being far more likely to be nearby.
      const lengthState = Math.min(length, LEN_TO_POS_STATES - 1);
      const posSlot = bitTreeDecode(decoder, posSlotProbs, lengthState << 6, 6);

      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const directBits = (posSlot >>> 1) - 1;
        let distance = ((2 | (posSlot & 1)) << directBits) >>> 0;

        if (posSlot < END_POS_MODEL_INDEX) {
          distance += bitTreeReverseDecode(
            decoder,
            specPosProbs,
            distance - posSlot - 1,
            directBits,
          );
        } else {
          distance += decoder.decodeDirectBits(directBits - ALIGN_BITS) * (1 << ALIGN_BITS);
          distance += bitTreeReverseDecode(decoder, alignProbs, 0, ALIGN_BITS);
        }

        if (distance === 0xffffffff) {
          // The end marker. A 7z stream normally stops on its known size
          // instead, so reaching this means the stream said it was done.
          break;
        }
        rep0 = distance >>> 0;
      }
    }

    length += MATCH_MIN_LEN;

    if (rep0 >= position) {
      throw new LzmaError('The compressed stream refers to data before its start');
    }
    if (position + length > outputSize) {
      // Clamping would hide the problem and hand back a header that parses
      // into confident nonsense.
      throw new LzmaError('The compressed stream unpacks to more than its declared size');
    }

    for (let index = 0; index < length; index += 1) {
      output[position] = output[position - rep0 - 1]!;
      position += 1;
    }
  }

  if (position !== outputSize) {
    throw new LzmaError('The compressed stream unpacked to less than its declared size');
  }

  return output;
}
