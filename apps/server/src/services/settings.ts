import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

export interface RuntimeSettings {
  serverName: string;
  tagline: string;
  allowSelfRegistration: boolean;
  /** Where the landing page sends visitors to get the Windows client. */
  downloadUrl: string | null;
  clientVersion: string | null;
  igdbClientId: string | null;
  igdbClientSecret: string | null;
  steamGridDbKey: string | null;
  /** Reads the public Steam achievement schema; no user data is involved. */
  steamApiKey: string | null;
  /** Ceiling on one download stream, in KB/s. 0 disables the limit. */
  downloadSpeedLimitKbps: number;
  /** Default monthly transfer allowance per account, in MB. 0 disables it. */
  monthlyQuotaMb: number;
}

const DEFAULT_TAGLINE = 'A private home for free-to-play and DRM-free games worth keeping.';

type SettingKey = keyof RuntimeSettings;

/**
 * Settings resolve database-first, then fall back to environment variables.
 *
 * That ordering lets an operator seed credentials through compose on first run
 * while still allowing an admin to change them later in the UI without editing
 * the stack and restarting the container.
 */
export class SettingsService {
  private cache: RuntimeSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get(): RuntimeSettings {
    if (this.cache) return this.cache;

    const rows = this.db.select().from(settings).all();
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));

    const asString = (key: SettingKey, fallback: string | null): string | null => {
      const value = stored.get(key);
      if (typeof value === 'string' && value.length > 0) return value;
      if (value === null) return null;
      return fallback;
    };

    const asBoolean = (key: SettingKey, fallback: boolean): boolean => {
      const value = stored.get(key);
      return typeof value === 'boolean' ? value : fallback;
    };

    const asNumber = (key: SettingKey, fallback: number): number => {
      const value = stored.get(key);
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };

    this.cache = {
      serverName: asString('serverName', 'GameBlade') ?? 'GameBlade',
      tagline: asString('tagline', DEFAULT_TAGLINE) ?? DEFAULT_TAGLINE,
      allowSelfRegistration: asBoolean('allowSelfRegistration', this.config.allowSelfRegistration),
      downloadUrl: asString('downloadUrl', this.config.clientDownloadUrl),
      clientVersion: asString('clientVersion', null),
      igdbClientId: asString('igdbClientId', this.config.igdb?.clientId ?? null),
      igdbClientSecret: asString('igdbClientSecret', this.config.igdb?.clientSecret ?? null),
      steamGridDbKey: asString('steamGridDbKey', this.config.steamGridDbKey),
      steamApiKey: asString('steamApiKey', this.config.steamApiKey),
      downloadSpeedLimitKbps: asNumber('downloadSpeedLimitKbps', 0),
      monthlyQuotaMb: asNumber('monthlyQuotaMb', 0),
    };
    return this.cache;
  }

  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      // Clearing a field (e.g. an emptied secret box) means "explicitly unset",
      // which get() has to tell apart from "never configured" — the former
      // must not fall back to an env-var default, the latter should. That
      // requires storing a real JSON null rather than omitting the row, but
      // handing the driver a bare JS null on this NOT NULL column bypasses
      // Drizzle's JSON encoder instead of running it, so it writes SQL NULL
      // straight through and the insert fails its own NOT NULL constraint —
      // every save that touched a blank field (which is most of them; the
      // settings form always sends clientVersion as null when unset) 500'd.
      // A literal JSON text 'null' round-trips through the same column as the
      // real value null on read, without going anywhere near that path.
      const encoded = value === null ? sql`'null'` : (value as never);

      this.db
        .insert(settings)
        .values({ key, value: encoded, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: encoded, updatedAt: now },
        })
        .run();
    }
    this.cache = null;
    return this.get();
  }

  /** Drop a stored override so the environment value applies again. */
  clear(key: SettingKey): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
