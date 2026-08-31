import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { DOWNLOAD_TOKEN_TTL_SECONDS } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { safeEqual } from '../lib/ids.js';

export interface DownloadClaims {
  userId: string;
  gameId: string;
  /** Restricts the token to one file; absent means the whole game. */
  fileId?: string;
  expiresAt: number;
}

const SECRET_KEY = 'downloadTokenSecret';
const SIGNING_KEY = 'meshSigningKeyPkcs8';

/**
 * Marks a token signed with the Ed25519 key rather than the HMAC secret.
 *
 * Tokens live for six hours, so an upgrade always finds some in flight. The
 * prefix lets `verify` tell the two apart instead of guessing, which is what
 * makes the switch invisible to a client mid-download.
 */
const V2_PREFIX = 'v2.';

/**
 * Stateless, signed download tokens.
 *
 * The desktop client opens many parallel connections per game and resumes them
 * across restarts. Issuing a signed token instead of a database row means those
 * connections cost no writes and survive a server restart, while still expiring
 * and still being scoped to one user and one game.
 *
 * The old HMAC secret is kept and still verified, because tokens issued before
 * an upgrade have to keep working until they expire on their own.
 */
export class DownloadTokenService {
  private secret: Buffer;
  private privateKey: KeyObject;
  private publicKey: KeyObject;

  constructor(
    private readonly db: Db,
    envSecret: string | null,
  ) {
    this.secret = envSecret ? Buffer.from(envSecret, 'utf8') : this.loadOrCreateSecret();
    const keys = this.loadOrCreateSigningKey();
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
  }

  private loadOrCreateSecret(): Buffer {
    const row = this.db.select().from(settings).where(eq(settings.key, SECRET_KEY)).get();
    if (row && typeof row.value === 'string' && row.value.length >= 32) {
      return Buffer.from(row.value, 'base64');
    }

    // Persist a generated secret so tokens stay valid across restarts.
    const generated = randomBytes(32);
    this.writeSetting(SECRET_KEY, generated.toString('base64'));
    return generated;
  }

  /**
   * The Ed25519 keypair this coordinator signs with.
   *
   * Stored as PKCS#8 rather than raw scalar bytes so it round-trips through
   * `createPrivateKey` without this file having to know anything about the
   * encoding, and so a rotation can be done by deleting one settings row.
   */
  private loadOrCreateSigningKey(): { privateKey: KeyObject; publicKey: KeyObject } {
    const row = this.db.select().from(settings).where(eq(settings.key, SIGNING_KEY)).get();

    if (row && typeof row.value === 'string' && row.value.length > 0) {
      try {
        const privateKey = createPrivateKey({
          key: Buffer.from(row.value, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
        return { privateKey, publicKey: createPublicKey(privateKey) };
      } catch {
        // A key that will not load is worse than no key: every token it signed
        // is unverifiable anyway, so generate a fresh one rather than refusing
        // to boot.
      }
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    this.writeSetting(SIGNING_KEY, der.toString('base64'));
    return { privateKey, publicKey };
  }

  private writeSetting(key: string, value: string): void {
    const updatedAt = new Date().toISOString();
    this.db
      .insert(settings)
      .values({ key, value: value as never, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt } })
      .run();
  }

  /**
   * The public half, base64url, used by compatibility tests and migrations.
   */
  publicKeyBase64(): string {
    // SPKI carries the algorithm identifier, so a verifier does not have to be
    // told out of band that this is Ed25519.
    return this.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  }

  issue(
    claims: Omit<DownloadClaims, 'expiresAt'>,
    ttlSeconds = DOWNLOAD_TOKEN_TTL_SECONDS,
  ): {
    token: string;
    expiresAt: string;
  } {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload: DownloadClaims = { ...claims, expiresAt };
    return {
      token: this.encode(payload),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  verify(token: string): DownloadClaims {
    const claims = this.decode<DownloadClaims>(token);

    if (claims.expiresAt * 1000 <= Date.now()) {
      // A code of its own, not plain `forbidden`: the desktop client refreshes
      // the token and retries when it sees this one, and must not treat an
      // ordinary authorisation failure as something retrying can fix.
      throw new ApiError(403, 'token_expired', 'This download link has expired.');
    }
    return claims;
  }

  /* ---------------------------------------------------------------- encoding */

  private encode(payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${V2_PREFIX}${body}.${this.signEd25519(body)}`;
  }

  private decode<T>(token: string): T {
    const isV2 = token.startsWith(V2_PREFIX);
    const [body, signature] = (isV2 ? token.slice(V2_PREFIX.length) : token).split('.', 2);
    if (!body || !signature) throw ApiError.forbidden('Malformed download token');

    const ok = isV2
      ? this.verifyEd25519(body, signature)
      : safeEqual(signature, this.signHmac(body));
    if (!ok) throw ApiError.forbidden('Invalid download token');

    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
      throw ApiError.forbidden('Malformed download token');
    }
  }

  private signEd25519(body: string): string {
    // Ed25519 does its own hashing, so the algorithm argument is null.
    return signBytes(null, Buffer.from(body, 'utf8'), this.privateKey).toString('base64url');
  }

  private verifyEd25519(body: string, signature: string): boolean {
    try {
      return verifyBytes(
        null,
        Buffer.from(body, 'utf8'),
        this.publicKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      // A signature that is not even well-formed base64url lands here; it is
      // simply invalid, not an error worth propagating.
      return false;
    }
  }

  /** Legacy, verify-only: tokens minted before the switch to Ed25519. */
  private signHmac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
