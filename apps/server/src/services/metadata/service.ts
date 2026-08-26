import {
  DISCOVERY_SHELVES,
  type ArtKind,
  type ArtworkCandidate,
  type ArtworkSearchResult,
  type DiscoveryShelfId,
  type MetadataCandidate,
  type ProviderStatus,
} from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { games, type Game } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';
import { matchKey } from '../../lib/titles.js';
import type { SettingsService } from '../settings.js';
import { IgdbClient, igdbImageUrl, normalizeIgdbGame, type IgdbGame } from './igdb.js';
import { ImageCache } from './images.js';
import { SteamGridDbClient } from './steamgriddb.js';

/** How long a discovery shelf is held before IGDB is asked again. */
const TRENDING_TTL_MS = 60 * 60_000;

/** One title offered on the request page, before the catalog is consulted. */
export interface DiscoveryCandidate {
  title: string;
  coverUrl: string | null;
  releaseYear: number | null;
  summary: string | null;
  rating: number | null;
}

/**
 * Which IGDB query backs each shelf.
 *
 * A lookup rather than a switch so the shelf list in the shared package stays
 * the single place a shelf is declared — adding one there is a type error here
 * until it is given a query.
 */
const SHELF_QUERIES: Record<DiscoveryShelfId, (igdb: IgdbClient) => Promise<IgdbGame[]>> = {
  trending: (igdb) => igdb.popular(24),
  anticipated: (igdb) => igdb.anticipated(24),
  recent: (igdb) => igdb.recentlyReleased(24),
  acclaimed: (igdb) => igdb.acclaimed(24),
};

/** Trims one IGDB game down to what a request card actually shows. */
function toCandidate(game: IgdbGame, proxy: (url: string) => string): DiscoveryCandidate {
  return {
    title: game.name,
    coverUrl: game.cover?.image_id ? proxy(igdbImageUrl(game.cover.image_id, 'cover_big')) : null,
    releaseYear: game.first_release_date
      ? new Date(game.first_release_date * 1000).getUTCFullYear()
      : null,
    // One line, not the whole blurb: these are cards in a row, and a card that
    // grows to fit four paragraphs breaks the row it sits in.
    summary: game.summary ? truncate(game.summary, 160) : null,
    rating: typeof game.total_rating === 'number' ? Math.round(game.total_rating) : null,
  };
}

/** Cuts at a word boundary so a card never ends mid-word. */
function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

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

/** The artwork slots IGDB can contribute to; it publishes no logos or icons. */
const IGDB_KINDS = ['cover', 'banner', 'hero'] as const;

interface ProviderHealth {
  reachable: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export class MetadataService {
  private igdb: { client: IgdbClient; key: string } | null = null;

  /** Every shelf is identical for every caller, so each is held once. */
  private shelfCache = new Map<DiscoveryShelfId, { at: number; items: DiscoveryCandidate[] }>();
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
    /** Prefix for the picker's thumbnail proxy; '' when hosted at the root. */
    private readonly basePath = '',
  ) {}

  /**
   * Rewrites a provider thumbnail to go through this server.
   *
   * The picker's previews are the one place the browser would otherwise load
   * images from IGDB and SteamGridDB directly, which both the page's content
   * security policy and the project's no-third-party-requests stance rule out.
   */
  private proxied(url: string): string {
    return `${this.basePath}/api/artwork/thumbnail?url=${encodeURIComponent(url)}`;
  }

  /**
   * One shelf's worth of titles, ready to be checked against the catalog.
   *
   * Cached for an hour per shelf: the lists are the same for every player on
   * the server, they move slowly, and IGDB's rate limit is four requests a
   * second shared across everything the server does — a request page that
   * asked on every open would spend that budget on identical answers.
   *
   * Returns an empty list rather than throwing when IGDB is not configured or
   * is unreachable: discovery is a convenience on a page that works without
   * it, so a provider outage must not take the page down with it.
   */
  async shelf(id: DiscoveryShelfId, limit = 12): Promise<DiscoveryCandidate[]> {
    const now = Date.now();
    const cached = this.shelfCache.get(id);
    if (cached && now - cached.at < TRENDING_TTL_MS) {
      return cached.items.slice(0, limit);
    }

    const igdb = this.getIgdb();
    if (!igdb) return [];

    try {
      const games = await SHELF_QUERIES[id](igdb);
      const items = games.map((game) => toCandidate(game, (url) => this.proxied(url)));
      this.shelfCache.set(id, { at: now, items });
      return items.slice(0, limit);
    } catch (error) {
      this.logger.warn({ err: error, shelf: id }, 'could not fetch a discovery shelf');
      // Hold the stale list rather than nothing if we ever had one.
      return cached?.items.slice(0, limit) ?? [];
    }
  }

  /**
   * Every shelf at once, for the client's request page.
   *
   * Fetched in parallel and settled independently: one shelf whose IGDB query
   * IGDB dislikes must leave the other three on the page rather than emptying
   * it. A shelf that comes back with nothing is dropped here, so the client
   * never has to render a labelled row with no cards under it.
   */
  async discover(limit = 12): Promise<{ id: DiscoveryShelfId; items: DiscoveryCandidate[] }[]> {
    if (!this.hasIgdb) return [];

    const results = await Promise.all(
      DISCOVERY_SHELVES.map(async (id) => ({ id, items: await this.shelf(id, limit) })),
    );
    return results.filter((shelf) => shelf.items.length > 0);
  }

  /**
   * Titles matching a search, for asking about something no shelf is showing.
   *
   * The point is that a player can find the exact game — with its cover, its
   * year and its blurb — rather than typing a title into a box and hoping the
   * operator recognises it. Uncached: a search is one person's, not the
   * server's, and IGDB is asked only when somebody actually types something.
   */
  async searchForRequest(term: string, limit = 12): Promise<DiscoveryCandidate[]> {
    const trimmed = term.trim();
    if (trimmed.length < 2) return [];

    const igdb = this.getIgdb();
    if (!igdb) return [];

    try {
      const games = await igdb.search(trimmed, limit);
      return games.map((game) => toCandidate(game, (url) => this.proxied(url)));
    } catch (error) {
      this.logger.warn({ err: error }, 'could not search IGDB for a request');
      return [];
    }
  }

  /**
   * Titles that are being played right now.
   *
   * Kept as its own name because it is the one shelf other callers ask for
   * directly; it is the `trending` shelf and shares its cache.
   */
  async trending(limit = 12): Promise<DiscoveryCandidate[]> {
    return this.shelf('trending', limit);
  }

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
        const game = normalizeIgdbGame(raw);
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
  async enrich(game: Game, signal?: AbortSignal): Promise<void> {
    // Only an unmatched entry is a candidate for automatic identification:
    // 'manual' is hand-curated and 'skipped' was excluded on purpose.
    if (game.matchStatus === 'unmatched' && this.hasIgdb) {
      // A successful match already pulls artwork using the provider's own
      // title, which is more accurate than the name parsed off disk.
      if (await this.autoMatch(game, signal)) return;
    }

    if (!game.coverImageId) {
      await this.fetchArtwork(game.id, game.searchTitle, signal);
    }
  }

  /**
   * Look up a game by its parsed title and apply the result when the match is
   * unambiguous. Games that stay unmatched surface in the admin UI for a manual fix.
   */
  async autoMatch(game: Game, signal?: AbortSignal): Promise<boolean> {
    const igdb = this.getIgdb();
    if (!igdb) return false;

    let results;
    try {
      results = await igdb.search(game.searchTitle, 8, signal);
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

    await this.applyIgdbGame(game.id, best.raw.id, 'auto', { signal });
    return true;
  }

  /** Fetch a specific IGDB game and write it onto the local record. */
  async applyIgdbGame(
    gameId: string,
    igdbId: number,
    matchStatus: 'auto' | 'manual',
    options: { refreshArtwork?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const igdb = this.getIgdb();
    if (!igdb) {
      throw ApiError.unavailable('IGDB is not configured. Add credentials in Settings.');
    }

    const raw = await igdb.getById(igdbId);
    if (!raw) throw ApiError.notFound('That IGDB entry no longer exists');

    const meta = normalizeIgdbGame(raw);
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
        // A provider has now written to this row, so the automatic pass leaves
        // it alone from here. A deliberate re-match comes back through this
        // same method and simply re-stamps it.
        metadataLockedAt: new Date().toISOString(),
      })
      .where(eq(games.id, gameId))
      .run();

    if (options.refreshArtwork !== false) {
      await this.fetchArtwork(gameId, meta.title, options.signal);
    }
  }

  /**
   * Pull poster/hero/logo/icon artwork from SteamGridDB. A SteamGridDB grid is
   * preferred over the IGDB cover because it is the artwork shaped for a poster
   * grid, but IGDB's cover stays as the fallback when nothing is published.
   */
  async fetchArtwork(gameId: string, title: string, signal?: AbortSignal): Promise<void> {
    const sgdb = this.getSgdb();
    if (!sgdb) return;

    const game = this.db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) return;

    try {
      const matches = await sgdb.search(title, signal);
      if (matches.length === 0) return;

      const best =
        matches.find((m) => matchKey(m.name) === matchKey(title)) ??
        matches.slice().sort((a, b) => similarity(title, b.name) - similarity(title, a.name))[0];
      if (!best || similarity(title, best.name) < 0.7) return;

      const [grids, banners, heroes, logos, icons] = await Promise.all([
        sgdb.grids(best.id).catch(() => []),
        sgdb.banners(best.id).catch(() => []),
        sgdb.heroes(best.id).catch(() => []),
        sgdb.logos(best.id).catch(() => []),
        sgdb.icons(best.id).catch(() => []),
      ]);

      const patch: Partial<typeof games.$inferInsert> = {
        sgdbId: best.id,
        updatedAt: new Date().toISOString(),
        // As in applyIgdbGame: artwork written here is the "initial set" the
        // automatic pass is not to revisit.
        metadataLockedAt: new Date().toISOString(),
      };

      const gridUrl = grids[0]?.url;
      if (gridUrl) {
        const id = await this.imageCache.cache(gridUrl, 'cover');
        if (id) patch.coverImageId = id;
      }
      const bannerUrl = banners[0]?.url;
      if (bannerUrl) {
        const id = await this.imageCache.cache(bannerUrl, 'banner');
        if (id) patch.bannerImageId = id;
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
  async searchArtwork(
    kind: ArtKind,
    query: string,
    options: { style?: string | null; limit?: number } = {},
  ): Promise<ArtworkSearchResult> {
    const style = options.style?.trim() || null;
    const limit = options.limit ?? 60;
    const candidates: ArtworkCandidate[] = [];
    const errors: ArtworkSearchResult['errors'] = [];
    const providers: ArtworkSearchResult['providers'] = [];

    const sgdb = this.getSgdb();
    if (sgdb) {
      providers.push('steamgriddb');
      try {
        candidates.push(...(await this.steamGridCandidates(sgdb, kind, query, style)));
      } catch (error) {
        errors.push({
          provider: 'steamgriddb',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // IGDB publishes no logos or icons, and its styles are not SteamGridDB's,
    // so it is consulted only for the shapes it has and only when the results
    // are not being narrowed to a SteamGridDB style.
    const igdb = this.getIgdb();
    if (igdb && !style && IGDB_KINDS.includes(kind as (typeof IGDB_KINDS)[number])) {
      providers.push('igdb');
      try {
        candidates.push(
          ...(await this.igdbCandidates(igdb, kind as (typeof IGDB_KINDS)[number], query)),
        );
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
      style,
      providers,
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
    style: string | null,
  ): Promise<ArtworkCandidate[]> {
    const matches = await sgdb.search(query);
    if (matches.length === 0) return [];

    // Only the best title match is browsed; pulling art for every near-miss
    // fills the picker with images from unrelated games.
    const best =
      matches.find((m) => matchKey(m.name) === matchKey(query)) ??
      matches.slice().sort((a, b) => similarity(query, b.name) - similarity(query, a.name))[0];
    if (!best) return [];

    // Cover and banner both come out of the grids bucket; what separates them
    // is the shape, so the banner asks for Steam's wide capsule dimensions.
    const bucket = {
      cover: 'grids',
      banner: 'grids',
      hero: 'heroes',
      logo: 'logos',
      icon: 'icons',
    } as const;
    const assets = await sgdb.browse(bucket[kind], best.id, {
      style,
      ...(kind === 'banner' ? { dimensions: '920x430,460x215' } : {}),
    });

    return assets.map((asset) => ({
      provider: 'steamgriddb' as const,
      url: asset.url,
      thumbnailUrl: this.proxied(asset.thumb || asset.url),
      width: asset.width,
      height: asset.height,
      label: asset.style ?? null,
      score: asset.score,
    }));
  }

  private async igdbCandidates(
    igdb: IgdbClient,
    kind: (typeof IGDB_KINDS)[number],
    query: string,
  ): Promise<ArtworkCandidate[]> {
    const images = await igdb.images(query);

    // A cover slot wants portrait cover art; the wide slots want artwork and
    // screenshots. Offering the wrong shape just makes the picker noisier.
    const wanted = kind === 'cover' ? ['cover'] : ['artwork', 'screenshot'];
    const size = kind === 'cover' ? 'cover_big' : '1080p';
    const thumbSize = kind === 'cover' ? 'cover_small' : 'thumb';

    return images
      .filter((image) => wanted.includes(image.source))
      .map((image) => ({
        provider: 'igdb' as const,
        url: igdbImageUrl(image.imageId, size),
        thumbnailUrl: this.proxied(igdbImageUrl(image.imageId, thumbSize)),
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
        bannerImageId: null,
        heroImageId: null,
        logoImageId: null,
        iconImageId: null,
        updatedAt: new Date().toISOString(),
        // Clearing a match is the way back into the enrichment queue: the row
        // now holds nothing worth protecting, so the lock comes off with it.
        metadataLockedAt: null,
      })
      .where(eq(games.id, gameId))
      .run();
  }
}
