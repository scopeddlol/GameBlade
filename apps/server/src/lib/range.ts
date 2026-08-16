export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export type RangeResult =
  | { type: 'none' }
  | { type: 'satisfiable'; range: ByteRange }
  | { type: 'unsatisfiable' };

/**
 * Parse a single-range `Range: bytes=...` header.
 *
 * Multi-range requests are answered with the full body instead, which the spec
 * permits and which no download client actually needs — resumable transfers
 * only ever ask for one contiguous span.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { type: 'none' };

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match?.[1]) return { type: 'none' };

  const specs = match[1].split(',');
  if (specs.length !== 1) return { type: 'none' };

  const spec = specs[0]?.trim() ?? '';
  const [rawStart, rawEnd] = spec.split('-', 2).map((s) => s?.trim() ?? '');

  // An empty file can satisfy no range at all.
  if (size === 0) return { type: 'unsatisfiable' };

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return { type: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isInteger(start) || start < 0) return { type: 'unsatisfiable' };
    if (start >= size) return { type: 'unsatisfiable' };

    if (rawEnd === '') {
      end = size - 1;
    } else {
      const parsedEnd = Number(rawEnd);
      if (!Number.isInteger(parsedEnd) || parsedEnd < start) return { type: 'unsatisfiable' };
      end = Math.min(parsedEnd, size - 1);
    }
  }

  return { type: 'satisfiable', range: { start, end, length: end - start + 1 } };
}

/** Weak validator derived from size and mtime, used for `If-Range`. */
export function makeETag(sizeBytes: number, modifiedAt: string): string {
  const mtime = Number.isNaN(Date.parse(modifiedAt)) ? 0 : Date.parse(modifiedAt);
  return `"${sizeBytes.toString(16)}-${mtime.toString(16)}"`;
}

/**
 * `If-Range` lets a client resume only if the file has not changed. A mismatch
 * means the server must ignore the Range and send the whole file again.
 */
export function ifRangeMatches(header: string | undefined, etag: string): boolean {
  if (!header) return true;
  return header.trim() === etag;
}
