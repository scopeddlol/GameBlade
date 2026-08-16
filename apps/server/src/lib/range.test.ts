import { describe, expect, it } from 'vitest';
import { ifRangeMatches, makeETag, parseRange } from './range.js';

const SIZE = 1000;

describe('parseRange', () => {
  it('returns none without a header', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ type: 'none' });
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({
      type: 'satisfiable',
      range: { start: 0, end: 499, length: 500 },
    });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({
      type: 'satisfiable',
      range: { start: 500, end: 999, length: 500 },
    });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({
      type: 'satisfiable',
      range: { start: 800, end: 999, length: 200 },
    });
  });

  it('clamps an end beyond the file size', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({
      type: 'satisfiable',
      range: { start: 900, end: 999, length: 100 },
    });
  });

  it('rejects a start at or past the end of the file', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ type: 'unsatisfiable' });
    expect(parseRange('bytes=5000-6000', SIZE)).toEqual({ type: 'unsatisfiable' });
  });

  it('rejects an inverted range', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ type: 'unsatisfiable' });
  });

  it('treats any range over an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-0', 0)).toEqual({ type: 'unsatisfiable' });
  });

  it('falls back to the full body for multi-range requests', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ type: 'none' });
  });

  it('ignores a malformed header rather than failing the download', () => {
    expect(parseRange('items=0-10', SIZE)).toEqual({ type: 'none' });
    expect(parseRange('bytes=abc-def', SIZE)).toEqual({ type: 'unsatisfiable' });
  });
});

describe('ifRangeMatches', () => {
  it('allows a resume when the validator still matches', () => {
    const etag = makeETag(123, new Date(0).toISOString());
    expect(ifRangeMatches(etag, etag)).toBe(true);
    expect(ifRangeMatches(undefined, etag)).toBe(true);
  });

  it('forces a full response when the file changed', () => {
    const etag = makeETag(123, new Date(0).toISOString());
    const changed = makeETag(456, new Date(0).toISOString());
    expect(ifRangeMatches(changed, etag)).toBe(false);
  });
});
