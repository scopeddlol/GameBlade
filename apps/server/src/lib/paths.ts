import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';

/**
 * Resolve `relPath` underneath `root`, refusing anything that escapes it.
 *
 * The library is mounted read-only, but a traversal would still let any signed-in
 * user read arbitrary files from the container, so this is enforced on every
 * download route rather than trusted from the database.
 */
export function resolveWithin(root: string, relPath: string): string {
  if (containsControlChars(relPath)) {
    throw ApiError.badRequest('Invalid path');
  }

  const normalisedRoot = path.resolve(root);
  // path.resolve collapses '..' before we can inspect it, so reject explicitly.
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw ApiError.badRequest('Invalid path');
  }
  if (path.isAbsolute(relPath)) {
    throw ApiError.badRequest('Invalid path');
  }

  const resolved = path.resolve(normalisedRoot, ...segments);
  if (!isInside(normalisedRoot, resolved)) {
    throw ApiError.badRequest('Invalid path');
  }
  return resolved;
}

/**
 * Follow symlinks and confirm the real target is still inside the root. Callers
 * that are about to stream bytes should use this; a symlink inside the library
 * pointing at /etc would otherwise slip past {@link resolveWithin}.
 */
export async function assertRealPathWithin(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    throw ApiError.notFound('File is no longer available');
  }
  if (!isInside(realRoot, realCandidate)) {
    throw ApiError.badRequest('Invalid path');
  }
  return realCandidate;
}

export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Database paths are always forward-slashed so they compare across platforms. */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

const SPACE = 0x20;
const DEL = 0x7f;
const TILDE = 0x7e;

/** Characters Windows refuses in a filename. */
const FORBIDDEN_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

function isControlChar(code: number): boolean {
  return code < SPACE || code === DEL;
}

function containsControlChars(value: string): boolean {
  for (const ch of value) {
    if (isControlChar(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** Strip characters that browsers and Windows reject in a saved filename. */
export function sanitiseFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (isControlChar(code)) continue;
    if (FORBIDDEN_FILENAME_CHARS.has(ch)) continue;
    out += ch;
  }
  const cleaned = out
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200)
    .trim();
  return cleaned || 'download';
}

/**
 * RFC 6266 Content-Disposition with both a plain and a UTF-8 filename, so
 * non-ASCII titles survive every browser.
 */
export function contentDisposition(filename: string): string {
  const safe = sanitiseFilename(filename);
  let ascii = '';
  for (const ch of safe) {
    const code = ch.codePointAt(0) ?? 0;
    ascii += code >= SPACE && code <= TILDE && ch !== '"' ? ch : '_';
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
