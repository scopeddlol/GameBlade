import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb, type Db, type DbHandle } from '../db/index.js';
import { SettingsService } from './settings.js';

/**
 * Every real save from the admin Settings page sends `clientVersion: null`
 * whenever that field is blank — which is every save until someone sets it —
 * because a cleared field has to mean "explicitly unset", not "never
 * touched": the former must not fall back to an env-var default. That
 * requires storing a genuine JSON null, and a naive insert into a NOT NULL
 * JSON-mode column bypasses the JSON encoder for a bare `null` and sends SQL
 * NULL straight through, so the write fails its own column constraint.
 *
 * That crashed the entire settings form, not just the field that happened to
 * be null — the update loop threw on the first null-valued key and never
 * reached the ones after it, including a freshly entered Steam API key.
 */
describe('SettingsService', () => {
  let dataDir: string;
  let db: Db;
  let sqlite: DbHandle['sqlite'];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-settings-test-'));
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

  function buildService(): SettingsService {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    return new SettingsService(db, config);
  }

  it('saves a real value alongside a null field in the same patch', () => {
    const settings = buildService();

    // clientVersion arrives null because the field is blank, exactly like the
    // web form's default state — this must not stop steamApiKey from saving.
    const result = settings.update({ clientVersion: null, steamApiKey: 'ABCDEF1234567890' });

    expect(result.clientVersion).toBeNull();
    expect(result.steamApiKey).toBe('ABCDEF1234567890');
  });

  it('persists a null across a cache reload, distinct from never being set', () => {
    const first = buildService();
    first.update({ igdbClientId: 'set-then-cleared' });
    first.update({ igdbClientId: null });

    // A fresh instance forces a real read from the database rather than the
    // in-memory cache, so this proves the null actually made it to disk.
    const reloaded = buildService();
    expect(reloaded.get().igdbClientId).toBeNull();
  });

  it('round-trips every stored type it accepts', () => {
    const settings = buildService();
    const result = settings.update({
      serverName: 'Test Archive',
      allowSelfRegistration: true,
      downloadUrl: null,
    });

    expect(result.serverName).toBe('Test Archive');
    expect(result.allowSelfRegistration).toBe(true);
    expect(result.downloadUrl).toBeNull();
  });

  it('enables a newly paired mesh without overriding an explicit off switch', () => {
    const settings = buildService();

    expect(settings.enableMeshWhenUnconfigured().meshEnabled).toBe(true);

    settings.update({ meshEnabled: false });
    expect(settings.enableMeshWhenUnconfigured().meshEnabled).toBe(false);
  });
});
