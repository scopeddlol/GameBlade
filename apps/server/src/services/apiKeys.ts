import {
  API_KEY_PREFIX,
  type ApiKeyInfo,
  type ApiScope,
  type CreateApiKeyInput,
  type CreatedApiKey,
} from '@gameblade/shared';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiKeys, users, type ApiKeyRow } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { hashToken, newId, newToken } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';

/**
 * `last_used_at` is written no more often than this per key.
 *
 * Without it every API request becomes a write, which on SQLite means taking
 * the write lock on a read-only call — the fastest way to turn a busy
 * integration into lock contention for everything else.
 */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** A resolved key, as the route guard sees it. */
export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: ApiScope[];
}

/**
 * Issues and resolves keys for the external API.
 *
 * Keys are deliberately not tied to a user account. An integration that
 * provisions accounts is not a person, and giving it a login would mean it
 * could also sign in to the desktop client and appear in the friends list.
 */
export class ApiKeyService {
  constructor(private readonly db: Db) {}

  list(): ApiKeyInfo[] {
    return this.db
      .select({ key: apiKeys, createdByUsername: users.username })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdBy))
      .orderBy(desc(apiKeys.createdAt))
      .all()
      .map(({ key, createdByUsername }) => toInfo(key, createdByUsername));
  }

  /**
   * Mints a key. The plaintext token is returned here and nowhere else — only
   * its digest is stored, so a lost key has to be replaced rather than looked up.
   */
  create(input: CreateApiKeyInput, createdBy: string): CreatedApiKey {
    const secret = newToken(32);
    const token = `${API_KEY_PREFIX}${secret}`;

    const record = {
      id: newId('key'),
      name: input.name,
      // Enough to tell two keys apart in a list, far too little to guess one.
      prefix: token.slice(0, API_KEY_PREFIX.length + 6),
      tokenHash: hashToken(token),
      scopes: input.scopes,
      createdBy,
      createdAt: isoNow(),
      lastUsedAt: null,
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      revokedAt: null,
    };

    this.db.insert(apiKeys).values(record).run();
    return { ...toInfo(record, null), token };
  }

  revoke(id: string): void {
    const existing = this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!existing) throw ApiError.notFound('That key no longer exists');
    this.db.update(apiKeys).set({ revokedAt: isoNow() }).where(eq(apiKeys.id, id)).run();
  }

  /** Deletes the row outright, for a key created by mistake. */
  remove(id: string): void {
    this.db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  }

  /**
   * Resolves a presented token, or null when it is unknown, revoked or expired.
   *
   * The lookup is by digest, so a token that is not an exact match simply finds
   * nothing — there is no comparison against a stored secret to get wrong.
   */
  resolve(token: string): ApiKeyContext | null {
    if (!token.startsWith(API_KEY_PREFIX)) return null;

    const row = this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tokenHash, hashToken(token)))
      .get();
    if (!row) return null;

    if (row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;

    this.touch(row);
    return { id: row.id, name: row.name, scopes: (row.scopes ?? []) as ApiScope[] };
  }

  private touch(row: ApiKeyRow): void {
    const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Date.now() - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.db.update(apiKeys).set({ lastUsedAt: isoNow() }).where(eq(apiKeys.id, row.id)).run();
  }
}

function toInfo(row: Omit<ApiKeyRow, 'tokenHash'>, createdByUsername: string | null): ApiKeyInfo {
  const expired = row.expiresAt !== null && new Date(row.expiresAt).getTime() <= Date.now();
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: (row.scopes ?? []) as ApiScope[],
    createdAt: row.createdAt,
    createdByUsername,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    isValid: row.revokedAt === null && !expired,
  };
}
