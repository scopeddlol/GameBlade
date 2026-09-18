import { open, type FileHandle } from 'node:fs/promises';
import { lzmaDecode, readLzmaProperties } from './lzma.js';

/**
 * Reads the file list out of a `.7z` archive without unpacking any of it.
 *
 * This is the 7z counterpart to reading a ZIP's central directory, and it is
 * here for one job: telling an administrator which `.exe` files a packaged game
 * contains so a launch rule can be picked from a list rather than typed from
 * memory. Nothing here extracts a game — the desktop client does that, in Rust.
 *
 * The two formats make that job very different amounts of work. A ZIP ends with
 * a plain directory of its entries; a 7z keeps an equivalent structure but
 * compresses it, so listing one means decoding a stream before any name can be
 * read. That is why `lzma.ts` exists beside this file.
 *
 * Only what a header needs is implemented. In particular a header stream is
 * either stored or LZMA-compressed — that is what 7-Zip itself writes, and has
 * since the format was defined — so an archive whose header uses anything else
 * is reported as unreadable rather than guessed at. Every caller already treats
 * "could not read this archive" as "offer no candidates", because a network
 * library full of archives that are momentarily unreachable had to work anyway.
 */

/** `7z¼¯'` — the six bytes every archive starts with. */
const SIGNATURE = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

/** Signature, version, and the offsets of the header that follows it. */
const SIGNATURE_HEADER_BYTES = 32;

/**
 * The largest header this will read into memory.
 *
 * A header is proportional to the number of entries, not to the size of the
 * game: even a hundred thousand files come to a few megabytes. The ceiling is
 * here so a corrupt or hostile size field is refused instead of allocated.
 */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/** Property ids, as the 7z format defines them. */
const ID = {
  end: 0x00,
  header: 0x01,
  archiveProperties: 0x02,
  additionalStreamsInfo: 0x03,
  mainStreamsInfo: 0x04,
  filesInfo: 0x05,
  packInfo: 0x06,
  unpackInfo: 0x07,
  subStreamsInfo: 0x08,
  size: 0x09,
  crc: 0x0a,
  folder: 0x0b,
  codersUnpackSize: 0x0c,
  numUnpackStream: 0x0d,
  emptyStream: 0x0e,
  emptyFile: 0x0f,
  anti: 0x10,
  name: 0x11,
  winAttributes: 0x15,
  encodedHeader: 0x17,
  dummy: 0x19,
} as const;

/** Coder ids this understands, as the big-endian numbers 7z stores them as. */
const CODER_COPY = 0x00;
const CODER_LZMA = 0x030101;

/** AES-256, recognised only so an encrypted header can be reported as one. */
const CODER_AES = 0x06f10701;

export class SevenZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SevenZipError';
  }
}

/** One entry in an archive: enough to list it, not enough to unpack it. */
export interface SevenZipEntry {
  /** The stored path, with 7z's Windows separators normalised to `/`. */
  path: string;
  /** Unpacked size in bytes; zero for a directory or an empty file. */
  sizeBytes: number;
  isDirectory: boolean;
}

/**
 * A cursor over a header's bytes.
 *
 * Every read is bounds-checked, because a header is the one part of an archive
 * that is parsed before anything about it has been verified — a truncated file
 * has to end as an error and not as an entry list built out of whatever
 * followed in memory.
 */
class Cursor {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) {
      throw new SevenZipError('The archive header ended early');
    }
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  take(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.bytes.length) {
      throw new SevenZipError('The archive header ended early');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  skip(count: number): void {
    this.take(count);
  }

  uint32(): number {
    const slice = this.take(4);
    return (slice[0]! | (slice[1]! << 8) | (slice[2]! << 16) | (slice[3]! << 24)) >>> 0;
  }

  /**
   * 7z's variable-length number.
   *
   * The leading byte's high bits say how many more bytes follow, and its low
   * bits carry the top of the value. Anything past 2^53 is refused rather than
   * silently rounded: a size that large in a header is corruption, and a
   * rounded one would place every later read at the wrong offset.
   */
  number(): number {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;

    for (let index = 0; index < 8; index += 1) {
      if ((first & mask) === 0) {
        const high = first & (mask - 1);
        value += high * 2 ** (index * 8);
        if (!Number.isSafeInteger(value)) {
          throw new SevenZipError('The archive header contains an unreasonable number');
        }
        return value;
      }
      value += this.byte() * 2 ** (index * 8);
      mask >>= 1;
    }

    if (!Number.isSafeInteger(value)) {
      throw new SevenZipError('The archive header contains an unreasonable number');
    }
    return value;
  }

  /** A bit per item, most significant bit first within each byte. */
  bitVector(count: number): boolean[] {
    const bits: boolean[] = new Array<boolean>(count);
    let current = 0;
    let mask = 0;

    for (let index = 0; index < count; index += 1) {
      if (mask === 0) {
        current = this.byte();
        mask = 0x80;
      }
      bits[index] = (current & mask) !== 0;
      mask >>= 1;
    }
    return bits;
  }

  /** The same, but with 7z's "all of them" shorthand in front. */
  definedVector(count: number): boolean[] {
    if (this.byte() !== 0) return new Array<boolean>(count).fill(true);
    return this.bitVector(count);
  }
}

/* ------------------------------------------------------------------ streams */

interface Coder {
  id: number;
  properties: Uint8Array;
  inStreams: number;
  outStreams: number;
}

interface Folder {
  coders: Coder[];
  unpackSizes: number[];
  packedStreamCount: number;
}

interface StreamsInfo {
  /** Where the packed streams start, relative to the end of the signature. */
  packPosition: number;
  packSizes: number[];
  folders: Folder[];
  /** How many files share each folder's decoded output. */
  streamsPerFolder: number[];
  /** Unpacked size of each substream, folder by folder. */
  substreamSizes: number[];
}

function readFolder(cursor: Cursor): Folder {
  const coderCount = cursor.number();
  if (coderCount === 0 || coderCount > 32) {
    throw new SevenZipError(`A header folder declares ${coderCount} coders`);
  }

  const coders: Coder[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let index = 0; index < coderCount; index += 1) {
    const flags = cursor.byte();
    const idSize = flags & 0x0f;
    const idBytes = cursor.take(idSize);

    let id = 0;
    for (const byte of idBytes) id = id * 256 + byte;

    let inStreams = 1;
    let outStreams = 1;
    // Bit 4 marks a coder with more than one stream on either side, such as
    // BCJ2's four inputs.
    if ((flags & 0x10) !== 0) {
      inStreams = cursor.number();
      outStreams = cursor.number();
    }

    let properties = new Uint8Array(0);
    if ((flags & 0x20) !== 0) {
      properties = Uint8Array.from(cursor.take(cursor.number()));
    }

    coders.push({ id, properties, inStreams, outStreams });
    totalIn += inStreams;
    totalOut += outStreams;
  }

  // Bind pairs wire one coder's output into the next coder's input; whatever
  // is left unbound is what comes from the packed streams on disk.
  const bindPairCount = totalOut - 1;
  const boundInputs = new Set<number>();
  for (let index = 0; index < bindPairCount; index += 1) {
    boundInputs.add(cursor.number());
    cursor.number();
  }

  const packedStreamCount = totalIn - bindPairCount;
  if (packedStreamCount !== 1) {
    // Only the index list is skipped here; a multi-stream folder is refused
    // later, by the decoder, where the error can say what it could not read.
    for (let index = 0; index < packedStreamCount; index += 1) cursor.number();
  }

  return { coders, unpackSizes: [], packedStreamCount };
}

function readStreamsInfo(cursor: Cursor): StreamsInfo {
  let packPosition = 0;
  let packSizes: number[] = [];
  let folders: Folder[] = [];
  let streamsPerFolder: number[] = [];
  let substreamSizes: number[] = [];
  let folderCrcDefined: boolean[] = [];
  let subStreamsRead = false;

  for (;;) {
    const id = cursor.number();
    if (id === ID.end) break;

    switch (id) {
      case ID.packInfo: {
        packPosition = cursor.number();
        const count = cursor.number();
        for (;;) {
          const inner = cursor.number();
          if (inner === ID.end) break;
          if (inner === ID.size) {
            packSizes = [];
            for (let index = 0; index < count; index += 1) packSizes.push(cursor.number());
          } else if (inner === ID.crc) {
            skipDigests(cursor, count);
          } else {
            throw new SevenZipError(`Unexpected property ${inner} in a 7z pack header`);
          }
        }
        break;
      }

      case ID.unpackInfo: {
        if (cursor.number() !== ID.folder) {
          throw new SevenZipError('A 7z unpack header does not begin with its folders');
        }
        const folderCount = cursor.number();
        if (cursor.byte() !== 0) {
          throw new SevenZipError('This archive keeps its folders in a separate stream');
        }
        folders = [];
        for (let index = 0; index < folderCount; index += 1) folders.push(readFolder(cursor));

        if (cursor.number() !== ID.codersUnpackSize) {
          throw new SevenZipError('A 7z unpack header is missing its sizes');
        }
        for (const folder of folders) {
          const outputs = folder.coders.reduce((total, coder) => total + coder.outStreams, 0);
          for (let index = 0; index < outputs; index += 1) {
            folder.unpackSizes.push(cursor.number());
          }
        }

        for (;;) {
          const inner = cursor.number();
          if (inner === ID.end) break;
          if (inner === ID.crc) {
            folderCrcDefined = skipDigests(cursor, folders.length);
          } else {
            throw new SevenZipError(`Unexpected property ${inner} in a 7z unpack header`);
          }
        }
        break;
      }

      case ID.subStreamsInfo: {
        subStreamsRead = true;
        streamsPerFolder = folders.map(() => 1);
        let next = cursor.number();

        if (next === ID.numUnpackStream) {
          streamsPerFolder = folders.map(() => cursor.number());
          next = cursor.number();
        }

        substreamSizes = [];
        for (let index = 0; index < folders.length; index += 1) {
          const count = streamsPerFolder[index]!;
          if (count === 0) continue;

          // The last substream of a folder is not stored: it is whatever is
          // left of the folder's output once the others are accounted for.
          let remaining = folderOutputSize(folders[index]!);
          if (next === ID.size) {
            for (let sub = 0; sub < count - 1; sub += 1) {
              const size = cursor.number();
              substreamSizes.push(size);
              remaining -= size;
            }
          } else if (count > 1) {
            throw new SevenZipError('A 7z folder holds several files but lists no sizes');
          }
          if (remaining < 0) {
            throw new SevenZipError('A 7z folder declares more content than it holds');
          }
          substreamSizes.push(remaining);
        }
        if (next === ID.size) next = cursor.number();

        for (;;) {
          if (next === ID.end) break;
          if (next === ID.crc) {
            skipDigests(cursor, countUnknownDigests(streamsPerFolder, folderCrcDefined));
          } else {
            throw new SevenZipError(`Unexpected property ${next} in a 7z substream header`);
          }
          next = cursor.number();
        }
        break;
      }

      default:
        throw new SevenZipError(`Unexpected property ${id} in a 7z streams header`);
    }
  }

  if (!subStreamsRead) {
    // No substream section means one file per folder, at the folder's size.
    streamsPerFolder = folders.map(() => 1);
    substreamSizes = folders.map((folder) => folderOutputSize(folder));
  }

  return { packPosition, packSizes, folders, streamsPerFolder, substreamSizes };
}

/**
 * A folder's final output size: the one output stream nothing else consumes.
 *
 * With a single coder that is simply its size. A chain — LZMA behind a BCJ
 * filter, say — has one output per coder and only the last is the real one,
 * which for every chain 7-Zip writes is the last size listed.
 */
function folderOutputSize(folder: Folder): number {
  return folder.unpackSizes[folder.unpackSizes.length - 1] ?? 0;
}

/**
 * Steps over a run of CRCs, returning which of them were actually stored.
 *
 * Nothing here verifies data — the desktop client checks every chunk it
 * downloads, and a header CRC would only restate that. The *defined* vector
 * still matters, because whether a folder carries its own CRC decides how many
 * substream CRCs follow, and a reader that guessed would land mid-number for
 * everything after this section.
 */
function skipDigests(cursor: Cursor, count: number): boolean[] {
  const defined = cursor.definedVector(count);
  for (const isDefined of defined) {
    if (isDefined) cursor.skip(4);
  }
  return defined;
}

/**
 * How many substream CRCs are actually stored.
 *
 * A folder holding exactly one file, whose CRC the folder already carries, does
 * not repeat it here — and a reader that counted it twice would misread every
 * byte after this section.
 */
function countUnknownDigests(streamsPerFolder: number[], folderCrcDefined: boolean[]): number {
  let total = 0;
  for (let index = 0; index < streamsPerFolder.length; index += 1) {
    const count = streamsPerFolder[index] ?? 0;
    if (count !== 1 || folderCrcDefined[index] !== true) total += count;
  }
  return total;
}

/* ------------------------------------------------------------------ decoding */

/**
 * Turns one folder's packed bytes into the stream it describes.
 *
 * Deliberately narrow: this is only ever asked to decode a *header*, and the
 * only coders 7-Zip writes one with are "stored" and LZMA. A header compressed
 * with anything else is refused by name, which is a far better bug report than
 * an empty file list.
 */
function decodeFolder(folder: Folder, packed: Uint8Array): Uint8Array {
  // `7z a -mhe=on` encrypts the header as well as the files. GameBlade has no
  // password to offer, so this is a permanent property of the archive rather
  // than a failure — worth saying plainly, since the operator's fix is to
  // republish it.
  if (folder.coders.some((coder) => coder.id === CODER_AES)) {
    throw new SevenZipError('This archive has an encrypted header, so it cannot be listed');
  }

  if (folder.coders.length !== 1 || folder.packedStreamCount !== 1) {
    throw new SevenZipError('This archive header is compressed with a chain of coders');
  }

  const coder = folder.coders[0]!;
  const size = folderOutputSize(folder);

  if (size > MAX_HEADER_BYTES) {
    throw new SevenZipError(`Refusing to read a ${size}-byte archive header`);
  }

  switch (coder.id) {
    case CODER_COPY:
      return packed.subarray(0, size);
    case CODER_LZMA:
      return lzmaDecode(packed, readLzmaProperties(coder.properties), size);
    default:
      throw new SevenZipError(
        `This archive header uses compression method 0x${coder.id.toString(16)}`,
      );
  }
}

/* -------------------------------------------------------------------- header */

interface FilesInfo {
  names: string[];
  emptyStream: boolean[];
  emptyFile: boolean[];
}

function readFilesInfo(cursor: Cursor): FilesInfo {
  const fileCount = cursor.number();
  let names: string[] = [];
  let emptyStream = new Array<boolean>(fileCount).fill(false);
  let emptyFile: boolean[] = [];

  for (;;) {
    const property = cursor.number();
    if (property === ID.end) break;

    const size = cursor.number();
    const start = cursor.position;

    switch (property) {
      case ID.emptyStream:
        emptyStream = cursor.bitVector(fileCount);
        break;

      case ID.emptyFile:
        emptyFile = cursor.bitVector(emptyStream.filter(Boolean).length);
        break;

      case ID.name: {
        if (cursor.byte() !== 0) {
          throw new SevenZipError('This archive keeps its file names in a separate stream');
        }
        names = readNames(cursor.take(size - 1), fileCount);
        break;
      }

      // Everything else — timestamps, attributes, anti-items, padding — has
      // no bearing on a file list. Each section states its own length, so the
      // skip below steps over one without this reader having to understand it.
      default:
        break;
    }

    const consumed = cursor.position - start;
    if (consumed > size) {
      throw new SevenZipError(`A 7z header section overran its declared ${size} bytes`);
    }
    cursor.skip(size - consumed);
  }

  if (names.length !== fileCount) {
    throw new SevenZipError('This archive does not name every file it contains');
  }

  return { names, emptyStream, emptyFile };
}

/**
 * File names: UTF-16, little-endian, each terminated by a zero unit.
 *
 * Surrogate pairs are left as they are and decoded by `TextDecoder`, so a
 * name outside the basic plane survives the trip. Separators are normalised
 * to `/` here rather than at every call site, because an archive built on
 * Windows stores `bin\game.exe` and one built anywhere else stores
 * `bin/game.exe` for the identical layout.
 */
function readNames(bytes: Uint8Array, expected: number): string[] {
  const decoder = new TextDecoder('utf-16le');
  const names: string[] = [];
  let start = 0;

  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    names.push(decoder.decode(bytes.subarray(start, offset)).replace(/\\/g, '/'));
    start = offset + 2;
    if (names.length > expected) break;
  }

  return names;
}

/* ------------------------------------------------------------------- reading */

async function readAt(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new SevenZipError('The archive is shorter than its own header says');
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
}

/**
 * Reads an archive's header, following the one indirection the format allows.
 *
 * A 7z's header is normally itself compressed, stored as a `kEncodedHeader`
 * that describes where its real header is packed and how. That is one hop, not
 * a chain: the decoded bytes must be a plain header, and an archive claiming
 * otherwise is refused rather than followed.
 */
async function readHeader(handle: FileHandle, fileSize: number): Promise<Cursor> {
  const signature = await readAt(handle, 0, SIGNATURE_HEADER_BYTES);
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (signature[index] !== SIGNATURE[index]) {
      throw new SevenZipError('This file is not a 7z archive');
    }
  }

  const view = new DataView(signature.buffer, signature.byteOffset, signature.byteLength);
  const headerOffset = Number(view.getBigUint64(12, true));
  const headerSize = Number(view.getBigUint64(20, true));

  if (headerSize === 0) {
    throw new SevenZipError('This archive is empty');
  }
  if (headerSize > MAX_HEADER_BYTES) {
    throw new SevenZipError(`Refusing to read a ${headerSize}-byte archive header`);
  }
  if (SIGNATURE_HEADER_BYTES + headerOffset + headerSize > fileSize) {
    throw new SevenZipError('This archive is truncated');
  }

  const cursor = new Cursor(
    await readAt(handle, SIGNATURE_HEADER_BYTES + headerOffset, headerSize),
  );

  const kind = cursor.number();
  if (kind === ID.header) return cursor;
  if (kind !== ID.encodedHeader) {
    throw new SevenZipError('This archive does not start with a header');
  }

  const streams = readStreamsInfo(cursor);
  const folder = streams.folders[0];
  if (!folder || streams.folders.length !== 1) {
    throw new SevenZipError('This archive describes its header in more than one piece');
  }

  const packedSize = streams.packSizes.reduce((total, size) => total + size, 0);
  const packed = await readAt(handle, SIGNATURE_HEADER_BYTES + streams.packPosition, packedSize);

  const decoded = new Cursor(decodeFolder(folder, packed));
  if (decoded.number() !== ID.header) {
    throw new SevenZipError('This archive header decoded into something else');
  }
  return decoded;
}

/**
 * Every entry in a `.7z`, with its unpacked size.
 *
 * Reads the header and nothing else, so the cost is proportional to the number
 * of entries rather than to the size of the archive — the same trade a ZIP's
 * central directory offers, which is what makes listing a hundred-gigabyte
 * game viable at all.
 */
export async function listSevenZipEntries(absolutePath: string): Promise<SevenZipEntry[]> {
  const handle = await open(absolutePath, 'r');
  try {
    const { size } = await handle.stat();
    const header = await readHeader(handle, size);

    let streams: StreamsInfo | null = null;
    let files: FilesInfo | null = null;

    for (;;) {
      const id = header.number();
      if (id === ID.end) break;

      switch (id) {
        case ID.mainStreamsInfo:
          streams = readStreamsInfo(header);
          break;
        case ID.filesInfo:
          files = readFilesInfo(header);
          break;
        case ID.archiveProperties:
          skipArchiveProperties(header);
          break;
        case ID.additionalStreamsInfo:
          // Only ever written for split archives, which have no single file to
          // open in the first place.
          throw new SevenZipError('This archive uses additional streams');
        default:
          throw new SevenZipError(`Unexpected property ${id} in a 7z header`);
      }
    }

    if (!files) return [];

    /*
     * Turning the three parallel vectors into entries.
     *
     * A 7z does not record "this is a directory" directly. It records which
     * entries have no content (`emptyStream`) and, among only those, which are
     * nonetheless files (`emptyFile`) — so a zero-byte file and a folder are
     * told apart by the second vector, and everything with content is a file
     * whose size comes from the substream list in order.
     */
    const sizes = streams?.substreamSizes ?? [];
    const entries: SevenZipEntry[] = [];
    let sizeIndex = 0;
    let emptyIndex = 0;

    for (let index = 0; index < files.names.length; index += 1) {
      const path = files.names[index]!;

      if (files.emptyStream[index]) {
        const isFile = files.emptyFile[emptyIndex] === true;
        emptyIndex += 1;
        entries.push({ path, sizeBytes: 0, isDirectory: !isFile });
        continue;
      }

      const sizeBytes = sizes[sizeIndex] ?? 0;
      sizeIndex += 1;
      entries.push({ path, sizeBytes, isDirectory: false });
    }

    return entries;
  } finally {
    await handle.close();
  }
}

/** Archive-wide properties, which nothing here reads but must still be stepped over. */
function skipArchiveProperties(cursor: Cursor): void {
  for (;;) {
    const id = cursor.number();
    if (id === ID.end) break;
    cursor.skip(cursor.number());
  }
}
