import { createHmac, randomBytes } from 'node:crypto';
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

/**
 * Stateless, signed download tokens.
 *
 * The desktop client opens many parallel connections per game and resumes them
 * across restarts. Issuing a signed token instead of a database row means those
 * connections cost no writes and survive a server restart, while still expiring
 * and still being scoped to one user and one game.
 */
export class DownloadTokenService {
  private secret: Buffer;

  constructor(
    private readonly db: Db,
    envSecret: string | null,
  ) {
    this.secret = envSecret ? Buffer.from(envSecret, 'utf8') : this.loadOrCreateSecret();
  }

  private loadOrCreateSecret(): Buffer {
    const row = this.db.select().from(settings).where(eq(settings.key, SECRET_KEY)).get();
    if (row && typeof row.value === 'string' && row.value.length >= 32) {
      return Buffer.from(row.value, 'base64');
    }

    // Persist a generated secret so tokens stay valid across restarts.
    const generated = randomBytes(32);
    const encoded = generated.toString('base64');
    this.db
      .insert(settings)
      .values({ key: SECRET_KEY, value: encoded as never, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encoded as never, updatedAt: new Date().toISOString() },
      })
      .run();
    return generated;
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
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = this.sign(body);
    return {
      token: `${body}.${signature}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  verify(token: string): DownloadClaims {
    const [body, signature] = token.split('.', 2);
    if (!body || !signature) throw ApiError.forbidden('Malformed download token');
    if (!safeEqual(signature, this.sign(body))) {
      throw ApiError.forbidden('Invalid download token');
    }

    let claims: DownloadClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DownloadClaims;
    } catch {
      throw ApiError.forbidden('Malformed download token');
    }

    if (claims.expiresAt * 1000 <= Date.now()) {
      throw ApiError.forbidden('This download link has expired. Refresh the page and try again.');
    }
    return claims;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
