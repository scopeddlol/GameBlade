import type {
  ArtKind,
  ArtworkCandidate,
  ArtworkSearchResult,
  MetadataCandidate,
  ProviderStatus,
} from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { games, type Game } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';
import { matchKey } from '../../lib/titles.js';
import type { SettingsService } from '../settings.js';
import { IgdbClient, igdbImageUrl, normaliseIgdbGame } from './igdb.js';
import { ImageCache } from './images.js';
import { SteamGridDbClient } from './steamgriddb.js';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

/** Dice coefficient over character bigrams — forgiving of subtitles and punctuation. */
export function similarity(a: string, b: string): number {
  const left = matchKey(a);
  const right = matchKey(b);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      intersection += 1;
    }
  }

  return (2 * intersection) / (left.length - 1 + (right.length - 1));
}

/** Above this, a search result is accepted without a human confirming it. */
const AUTO_MATCH_THRESHOLD = 0.86;

interface ProviderHealth {
  reachable: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export class MetadataService {
  private igdb: { client: IgdbClient; key: string } | null = null;
  private sgdb: { client: SteamGridDbClient; key: string } | null = null;
  private health: Record<'igdb' | 'steamgriddb', ProviderHealth> = {
    igdb: { reachable: null, lastError: null, lastCheckedAt: null },
    steamgriddb: { reachable: null, lastError: null, lastCheckedAt: null },
  };

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    readonly imageCache: ImageCache,
    private readonly logger: Logger,
  ) {}

  /** Clients are rebuilt whenever the stored credentials change. */
  private getIgdb(): IgdbClient | null {
    const { igdbClientId, igdbClientSecret } = this.settings.get();
    if (!igdbClientId || !igdbClientSecret) return null;

    const key = `${igdbClientId}:${igdbClientSecret}`;
    if (this.igdb?.key !== key) {
      this.igdb = { client: new IgdbClient(igdbClientId, igdbClientSecret), key };
    }
    return this.igdb.client;
  }

  private getSgdb(): SteamGridDbClient | null {
    const { steamGridDbKey } = this.settings.get();
    if (!steamGridDbKey) return null;

    if (this.sgdb?.key !== steamGridDbKey) {
      this.sgdb = { client: new SteamGridDbClient(steamGridDbKey), key: steamGridDbKey };
    }
    return this.sgdb.client;
  }

  get hasIgdb(): boolean {
    return this.getIgdb() !== null;
  }

  get hasSteamGridDb(): boolean {
    return this.getSgdb() !== null;
  }

  status(): ProviderStatus[] {
    return [
      { name: 'igdb', configured: this.hasIgdb, ...this.health.igdb },
      { name: 'steamgriddb', configured: this.hasSteamGridDb, ...this.health.steamgriddb },
    ];
  }

  /** Actively probe both providers; used by the admin settings page. */
  async checkHealth(): Promise<ProviderStatus[]> {
    const checkedAt = new Date().toISOString();

    const igdb = this.getIgdb();
    if (igdb) {
      try {
        await igdb.verify();
        this.health.igdb = { reachable: true, lastError: null, lastCheckedAt: checkedAt };
      } catch (error) {
        this.health.igdb = {
          reachable: false,
          lastError: error instanceof Error ? error.message : String(error),
          lastCheckedAt: checkedAt,
        };
      }
    } else {
      this.health.igdb = { reachable: null, lastError: null, lastCheckedAt: checkedAt };
    }

    const sgdb = this.getSgdb();
    if (sgdb) {
      try {
        await sgdb.verify();
        this.health.steamgriddb = { reachable: true, lastError: null, lastCheckedAt: checkedAt };
      } catch (error) {
        this.health.steamgriddb = {
          reachable: false,
          lastError: error instanceof Error ? error.message : String(error),
          lastCheckedAt: checkedAt,
        };
      }
    } else {
      this.health.steamgriddb = { reachable: null, lastError: null, lastCheckedAt: checkedAt };
    }

    return this.status();
  }

  async searchCandidates(title: string, limit = 10): Promise<MetadataCandidate[]> {
    const igdb = this.getIgdb();
    if (!igdb) {
      throw ApiError.unavailable('IGDB is not configured. Add credentials in Settings.');
    }

    const results = await igdb.search(title, limit);
    return results
      .map((raw) => {
        const game = normaliseIgdbGame(raw);
        return {
          provider: 'igdb' as const,
          id: game.igdbId,
          title: game.title,
          releaseDate: game.releaseDate,
          summary: game.summary,
          coverUrl: game.coverUrl,
          platforms: game.platforms,
        };
      })
      .sort((a, b) => similarity(title, b.title) - similarity(title, a.title));
  }

  /**
   * Bring one game up to date from whatever providers are available.
   *
   * Artwork is deliberately *not* conditional on an IGDB match. SteamGridDB is
   * searched by title and knows nothing about IGDB, so coupling the two meant a
   * single broken IGDB query left the entire library with no covers at all —
   * which is exactly what happened. Each provider now contributes whatever it
   * can on its own.
   */
  async enrich(game: Game): Promise<void> {
    // Only an unmatched entry is a candidate for automatic identification:
    // 'manual' is hand-curated and 'skipped' was excluded on purpose.
    if (game.matchStatus === 'unmatched' && this.hasIgdb) {
      // A successful match already pulls artwork using the provider's own
      // title, which is more accurate than the name parsed off disk.
      if (await this.autoMatch(game)) return;
    }

    if (!game.coverImageId) {
      await this.fetchArtwork(game.id, game.searchTitle);
    }
  }

  /**
   * Look up a game by its parsed title and apply the result when the match is
   * unambiguous. Games that stay unmatched surface in the admin UI for a manual fix.
   */
  async autoMatch(game: Game): Promise<boolean> {
    const igdb = this.getIgdb();
    if (!igdb) return false;

    let results;
    try {
      results = await igdb.search(game.searchTitle, 8);
    } catch (error) {
      this.logger.warn({ err: error, title: game.searchTitle }, 'IGDB search failed');
      this.health.igdb = {
        reachable: false,
        lastError: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
      return false;
    }

    if (results.length === 0) return false;

    const scored = results
      .map((raw) => ({ raw, score: similarity(game.searchTitle, raw.name) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < AUTO_MATCH_THRESHOLD) {
      this.logger.debug(
        { title: game.searchTitle, best: best?.raw.name, score: best?.score },
        'no confident IGDB match',
      );
      return false;
    }

    await this.applyIgdbGame(game.id, best.raw.id, 'auto');
    return true;
  }

  /** Fetch a specific IGDB game and write it onto the local record. */
  async applyIgdbGame(
    gameId: string,
    igdbId: number,
    matchStatus: 'auto' | 'manual',
    options: { refreshArtwork?: boolean } = {},
  ): Promise<void> {
    const igdb = this.getIgdb();
    if (!igdb) {
      throw ApiError.unavailable('IGDB is not configured. Add credentials in Settings.');
    }

    const raw = await igdb.getById(igdbId);
    if (!raw) throw ApiError.notFound('That IGDB entry no longer exists');

    const meta = normaliseIgdbGame(raw);
    const coverImageId = meta.coverUrl ? await this.imageCache.cache(meta.coverUrl, 'cover') : null;

    const screenshotIds: string[] = [];
    for (const url of meta.screenshotUrls) {
      const id = await this.imageCache.cache(url, 'screenshot');
      if (id) screenshotIds.push(id);
    }

    this.db
      .update(games)
      .set({
        igdbId: meta.igdbId,
        matchStatus,
        summary: meta.summary,
        storyline: meta.storyline,
        releaseDate: meta.releaseDate,
        rating: meta.rating,
        developers: meta.developers,
        publishers: meta.publishers,
        genres: meta.genres,
        platforms: meta.platforms,
        screenshots: screenshotIds,
        videos: meta.videoIds,
        coverImageId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(games.id, gameId))
      .run();

    if (options.refreshArtwork !== false) {
      await this.fetchArtwork(gameId, meta.title);
    }
  }

  /**
   * Pull poster/hero/logo/icon artwork from SteamGridDB. A SteamGridDB grid is
   * preferred over the IGDB cover because it is the artwork shaped for a poster
   * grid, but IGDB's cover stays as the fallback when nothing is published.
   */
  async fetchArtwork(gameId: string, title: string): Promise<void> {
    const sgdb = this.getSgdb();
    if (!sgdb) return;

    const game = this.db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) return;

    try {
      const matches = await sgdb.search(title);
      if (matches.length === 0) return;

      const best =
        matches.find((m) => matchKey(m.name) === matchKey(title)) ??
        matches.slice().sort((a, b) => similarity(title, b.name) - similarity(title, a.name))[0];
      if (!best || similarity(title, best.name) < 0.7) return;

      const [grids, heroes, logos, icons] = await Promise.all([
        sgdb.grids(best.id).catch(() => []),
        sgdb.heroes(best.id).catch(() => []),
        sgdb.logos(best.id).catch(() => []),
        sgdb.icons(best.id).catch(() => []),
      ]);

      const patch: Partial<typeof games.$inferInsert> = {
        sgdbId: best.id,
        updatedAt: new Date().toISOString(),
      };

      const gridUrl = grids[0]?.url;
      if (gridUrl) {
        const id = await this.imageCache.cache(gridUrl, 'cover');
        if (id) patch.coverImageId = id;
      }
      const heroUrl = heroes[0]?.url;
      if (heroUrl) {
        const id = await this.imageCache.cache(heroUrl, 'hero');
        if (id) patch.heroImageId = id;
      }
      const logoUrl = logos[0]?.url;
      if (logoUrl) {
        const id = await this.imageCache.cache(logoUrl, 'logo');
        if (id) patch.logoImageId = id;
      }
      const iconUrl = icons[0]?.url;
      if (iconUrl) {
        const id = await this.imageCache.cache(iconUrl, 'icon');
        if (id) patch.iconImageId = id;
      }

      this.db.update(games).set(patch).where(eq(games.id, gameId)).run();
      this.health.steamgriddb = {
        reachable: true,
        lastError: null,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn({ err: error, title }, 'SteamGridDB artwork fetch failed');
      this.health.steamgriddb = {
        reachable: false,
        lastError: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Collect every image both providers offer for a title, so an administrator
   * can pick one by eye instead of trusting whatever the automatic pass chose.
   *
   * A provider that fails is reported rather than dropped: a picker showing
   * only half the results should say why, not look like the other provider had
   * nothing.
   */
  async searchArtwork(kind: ArtKind, query: string, limit = 40): Promise<ArtworkSearchResult> {
    const candidates: ArtworkCandidate[] = [];
    const errors: ArtworkSearchResult['errors'] = [];

    const sgdb = this.getSgdb();
    if (sgdb) {
      try {
        candidates.push(...(await this.steamGridCandidates(sgdb, kind, query)));
      } catch (error) {
        errors.push({
          provider: 'steamgriddb',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // IGDB has no logos or icons, so it is only consulted for the two kinds it
    // can actually answer.
    const igdb = this.getIgdb();
    if (igdb && (kind === 'cover' || kind === 'hero')) {
      try {
        candidates.push(...(await this.igdbCandidates(igdb, kind, query)));
      } catch (error) {
        errors.push({
          provider: 'igdb',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      kind,
      query,
      // Highest community score first; unscored IGDB images fall in behind
      // SteamGridDB's ranked art rather than displacing it.
      candidates: candidates.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, limit),
      errors,
    };
  }

  private async steamGridCandidates(
    sgdb: SteamGridDbClient,
    kind: ArtKind,
    query: string,
  ): Promise<ArtworkCandidate[]> {
    const matches = await sgdb.search(query);
    if (matches.length === 0) return [];

    // Only the best title match is browsed; pulling art for every near-miss
    // fills the picker with images from unrelated games.
    const best =
      matches.find((m) => matchKey(m.name) === matchKey(query)) ??
      matches.slice().sort((a, b) => similarity(query, b.name) - similarity(query, a.name))[0];
    if (!best) return [];

    const bucket = { cover: 'grids', hero: 'heroes', logo: 'logos', icon: 'icons' } as const;
    const assets = await sgdb.browse(bucket[kind], best.id);

    return assets.map((asset) => ({
      provider: 'steamgriddb' as const,
      url: asset.url,
      thumbnailUrl: asset.thumb || asset.url,
      width: asset.width,
      height: asset.height,
      label: asset.style ?? null,
      score: asset.score,
    }));
  }

  private async igdbCandidates(
    igdb: IgdbClient,
    kind: 'cover' | 'hero',
    query: string,
  ): Promise<ArtworkCandidate[]> {
    const images = await igdb.images(query);

    // A cover slot wants portrait cover art; a hero wants the wide artwork and
    // screenshots. Offering the wrong shape just makes the picker noisier.
    const wanted = kind === 'cover' ? ['cover'] : ['artwork', 'screenshot'];

    return images
      .filter((image) => wanted.includes(image.source))
      .map((image) => ({
        provider: 'igdb' as const,
        url: igdbImageUrl(image.imageId, kind === 'cover' ? 'cover_big' : '1080p'),
        thumbnailUrl: igdbImageUrl(image.imageId, kind === 'cover' ? 'cover_small' : 'thumb'),
        width: null,
        height: null,
        label: `${image.source} · ${image.gameName}`,
        score: null,
      }));
  }

  /** Detach provider metadata, leaving the scanned files untouched. */
  clearMatch(gameId: string): void {
    this.db
      .update(games)
      .set({
        igdbId: null,
        sgdbId: null,
        matchStatus: 'unmatched',
        summary: null,
        storyline: null,
        releaseDate: null,
        rating: null,
        developers: null,
        publishers: null,
        genres: null,
        platforms: null,
        screenshots: null,
        videos: null,
        coverImageId: null,
        heroImageId: null,
        logoImageId: null,
        iconImageId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(games.id, gameId))
      .run();
  }
}
