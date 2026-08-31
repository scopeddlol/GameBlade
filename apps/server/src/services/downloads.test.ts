import { createHmac, createPublicKey, verify as verifyBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb, type Db, type DbHandle } from '../db/index.js';
import { settings } from '../db/schema.js';
import { DownloadTokenService } from './downloads.js';

/**
 * Download tokens survive restarts, reject tampering, and retain compatibility
 * with tokens issued before asymmetric signing was introduced.
 */
describe('DownloadTokenService', () => {
  let dataDir: string;
  let db: Db;
  let sqlite: DbHandle['sqlite'];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-tokens-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    ({ db, sqlite } = createDb(config.databasePath));
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips its own tokens', () => {
    const service = new DownloadTokenService(db, null);
    const { token } = service.issue({ userId: 'usr_1', gameId: 'gam_1' });

    expect(service.verify(token)).toMatchObject({ userId: 'usr_1', gameId: 'gam_1' });
  });

  it('keeps the same key across restarts', () => {
    // Tokens outlive a container restart by design; a key regenerated at boot
    // would invalidate every download in flight.
    const first = new DownloadTokenService(db, null);
    const { token } = first.issue({ userId: 'usr_1', gameId: 'gam_1' });

    const second = new DownloadTokenService(db, null);
    expect(second.verify(token)).toMatchObject({ userId: 'usr_1' });
    expect(second.publicKeyBase64()).toBe(first.publicKeyBase64());
  });

  it('issues a token a public-key holder can verify without the private key', () => {
    // The public key proves a token came from this Coordinator.
    const service = new DownloadTokenService(db, null);
    const { token } = service.issue({ userId: 'usr_1', gameId: 'gam_1' });

    const publicKey = createPublicKey({
      key: Buffer.from(service.publicKeyBase64(), 'base64url'),
      format: 'der',
      type: 'spki',
    });

    const [body, signature] = token.slice('v2.'.length).split('.', 2);
    expect(
      verifyBytes(
        null,
        Buffer.from(body as string, 'utf8'),
        publicKey,
        Buffer.from(signature as string, 'base64url'),
      ),
    ).toBe(true);
  });

  it('rejects a token whose payload was edited', () => {
    const service = new DownloadTokenService(db, null);
    const { token } = service.issue({ userId: 'usr_1', gameId: 'gam_1' });

    const [body, signature] = token.slice('v2.'.length).split('.', 2);
    const claims = JSON.parse(Buffer.from(body as string, 'base64url').toString('utf8'));
    claims.userId = 'usr_admin';
    const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

    expect(() => service.verify(`v2.${forged}.${signature}`)).toThrow(/Invalid download token/);
  });

  it('still verifies HMAC tokens issued before the switch', () => {
    const service = new DownloadTokenService(db, null);
    const secret = Buffer.from(
      db.select().from(settings).where(eq(settings.key, 'downloadTokenSecret')).get()
        ?.value as string,
      'base64',
    );

    const claims = {
      userId: 'usr_old',
      gameId: 'gam_old',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const legacy = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;

    expect(service.verify(legacy)).toMatchObject({ userId: 'usr_old' });
  });

  it('reports an expired token with a code the client retries on', () => {
    const service = new DownloadTokenService(db, null);
    const { token } = service.issue({ userId: 'usr_1', gameId: 'gam_1' }, -1);

    // `token_expired` means refresh and continue; plain `forbidden` means stop.
    // Conflating them turns a paused weekend download into a failed one.
    expect(() => service.verify(token)).toThrow(/expired/);
    try {
      service.verify(token);
    } catch (error) {
      expect((error as { code: string }).code).toBe('token_expired');
    }
  });
});
