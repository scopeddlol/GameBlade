import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { contentDisposition, isInside, resolveWithin, sanitiseFilename } from './paths.js';

const ROOT = path.resolve('/library');

describe('resolveWithin', () => {
  it('resolves a normal relative path', () => {
    expect(resolveWithin(ROOT, 'Hollow Knight')).toBe(path.join(ROOT, 'Hollow Knight'));
    expect(resolveWithin(ROOT, 'Hades/data/game.pak')).toBe(
      path.join(ROOT, 'Hades', 'data', 'game.pak'),
    );
  });

  it('accepts backslash separators from Windows-authored records', () => {
    expect(resolveWithin(ROOT, 'Hades\\data\\game.pak')).toBe(
      path.join(ROOT, 'Hades', 'data', 'game.pak'),
    );
  });

  it('rejects traversal out of the root', () => {
    expect(() => resolveWithin(ROOT, '../etc/passwd')).toThrow(ApiError);
    expect(() => resolveWithin(ROOT, 'Hades/../../etc/passwd')).toThrow(ApiError);
    expect(() => resolveWithin(ROOT, 'Hades/../..')).toThrow(ApiError);
  });

  it('rejects an absolute path', () => {
    expect(() => resolveWithin(ROOT, path.resolve('/etc/passwd'))).toThrow(ApiError);
  });

  it('rejects control characters', () => {
    expect(() => resolveWithin(ROOT, `Hades${String.fromCharCode(0)}.exe`)).toThrow(ApiError);
  });

  it('ignores redundant separators and current-directory segments', () => {
    expect(resolveWithin(ROOT, './Hades//data/./game.pak')).toBe(
      path.join(ROOT, 'Hades', 'data', 'game.pak'),
    );
  });
});

describe('isInside', () => {
  it('accepts the root itself and descendants', () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, path.join(ROOT, 'a', 'b'))).toBe(true);
  });

  it('rejects siblings that merely share a prefix', () => {
    expect(isInside(ROOT, `${ROOT}-other`)).toBe(false);
    expect(isInside(ROOT, path.resolve('/elsewhere'))).toBe(false);
  });
});

describe('sanitiseFilename', () => {
  it('keeps digits and ordinary punctuation', () => {
    expect(sanitiseFilename('Half-Life 2 (2004).zip')).toBe('Half-Life 2 (2004).zip');
  });

  it('strips characters Windows forbids', () => {
    expect(sanitiseFilename('Portal: Prelude?.zip')).toBe('Portal Prelude.zip');
  });

  it('never returns an empty name', () => {
    expect(sanitiseFilename('///')).toBe('download');
  });
});

describe('contentDisposition', () => {
  it('emits both an ASCII and a UTF-8 filename', () => {
    const header = contentDisposition('Ōkami.zip');
    expect(header).toContain('filename="_kami.zip"');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent('Ōkami.zip'));
  });
});
