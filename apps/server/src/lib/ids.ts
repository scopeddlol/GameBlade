import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe, sortable-enough identifier for database rows. */
export function newId(prefix = ''): string {
  const random = randomBytes(12).toString('base64url');
  return prefix ? `${prefix}_${random}` : random;
}

/** High-entropy opaque token handed to clients; never stored as-is. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-typable invite code, e.g. `K7QM-3XPD-9RTV`. Excludes I/O/0/1. */
export function newInviteCode(): string {
  const raw = randomBytes(12);
  const chars = Array.from(raw, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((group) => group.join(''))
    .join('-');
}

export function normaliseInviteCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}
