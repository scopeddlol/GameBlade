import { hash, verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` is an ambient const enum, which cannot be imported under
 * `verbatimModuleSyntax`. Its numeric value is part of the argon2 format and is
 * stable, so it is inlined here.
 */
const ARGON2ID = 2;

/**
 * OWASP's low-memory Argon2id profile: 19 MiB, 2 passes, 1 lane. Cheap enough
 * that a small NAS can serve a login without stalling, strong enough that the
 * hashes are useless if the database ever leaks.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, OPTIONS);
  } catch {
    // A malformed hash must fail closed rather than throw a 500 on the login route.
    return false;
  }
}

/**
 * Burn roughly the same time as a real verification when the username does not
 * exist, so login timing does not reveal which accounts are registered.
 */
export async function fakeVerify(): Promise<void> {
  await hash('gameblade-timing-equaliser', OPTIONS);
}
