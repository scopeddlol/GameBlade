import {
  HttpError,
  REQUEST_TIMEOUT_MS,
  RateLimiter,
  requestSignal,
  withRetry,
} from '../../lib/ratelimit.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_URL = 'https://api.igdb.com/v4';

/** IGDB serves every asset from one CDN; `t_*` selects the rendition. */
export function igdbImageUrl(
  imageId: string,
  size: 'cover_big' | 'cover_small' | '1080p' | '720p' | 'screenshot_big' | 'thumb',
): string {
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}

/** One IGDB image offered to the admin picker. */
export interface IgdbImage {
  imageId: string;
  /** Which field it came from, shown as the candidate's label. */
  source: 'cover' | 'artwork' | 'screenshot';
  gameName: string;
}

interface IgdbCompany {
  company?: { name?: string };
  developer?: boolean;
  publisher?: boolean;
}

export interface IgdbGame {
  id: number;
  name: string;
  summary?: string;
  storyline?: string;
  first_release_date?: number;
  total_rating?: number;
  rating?: number;
  cover?: { image_id?: string };
  genres?: Array<{ name?: string }>;
  platforms?: Array<{ name?: string }>;
  involved_companies?: IgdbCompany[];
  screenshots?: Array<{ image_id?: string }>;
  videos?: Array<{ video_id?: string }>;
  /** Absent once IGDB has rejected the field; see TYPE_FIELD. */
  game_type?: number;
}

/**
 * Fields every query asks for. Deliberately excludes anything IGDB has
 * deprecated: a single unknown name makes the whole request fail with
 * "Invalid Field", which takes down search, matching and artwork with it.
 */
const GAME_FIELDS = [
  'name',
  'summary',
  'storyline',
  'first_release_date',
  'total_rating',
  'rating',
  'cover.image_id',
  'genres.name',
  'platforms.name',
  'involved_companies.company.name',
  'involved_companies.developer',
  'involved_companies.publisher',
  'screenshots.image_id',
  'videos.video_id',
].join(',');

/**
 * IGDB renamed `category` to `game_type`, and the old name now returns
 * "Invalid Field" rather than being ignored. Requesting either one is
 * therefore a gamble on which side of that rename the API is on today, so the
 * field is probed once and dropped for good if it is rejected.
 *
 * Losing it costs only ordering: results are ranked by title similarity
 * regardless, and a base game beats its own DLC on that measure anyway.
 */
const TYPE_FIELD = 'game_type';

/** `game_type` value for a standalone main game. */
const MAIN_GAME = 0;

export class IgdbClient {
  /** 4 requests/second, 8 concurrent — the documented IGDB ceiling. */
  private readonly limiter = new RateLimiter(4, 8);
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  /** Cleared permanently the first time IGDB rejects the optional type field. */
  private typeFieldUsable = true;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    // Collapse concurrent refreshes so a burst of scans issues one token request.
    this.tokenPromise ??= this.fetchToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });

    const response = await fetch(`${TOKEN_URL}?${params.toString()}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `IGDB token request failed (${response.status}). Check the Twitch client ID and secret.`,
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return body.access_token;
  }

  private async query<T>(endpoint: string, apicalypse: string, signal?: AbortSignal): Promise<T[]> {
    return withRetry(() =>
      this.limiter.run(async () => {
        const token = await this.getToken();
        const response = await fetch(`${API_URL}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Client-ID': this.clientId,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/plain',
            Accept: 'application/json',
          },
          body: apicalypse,
          signal: requestSignal(REQUEST_TIMEOUT_MS, signal),
        });

        if (response.status === 401) {
          // Force a refresh on the next attempt; the cached token is stale.
          this.token = null;
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new HttpError(
            response.status,
            `IGDB ${endpoint} failed (${response.status}): ${detail.slice(0, 200)}`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          );
        }
        return (await response.json()) as T[];
      }),
    );
  }

  /** Escape a user-supplied title for an apicalypse string literal. */
  private static quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  /** Field list for this request, minus anything IGDB has already rejected. */
  private fields(): string {
    return this.typeFieldUsable ? `${GAME_FIELDS},${TYPE_FIELD}` : GAME_FIELDS;
  }

  /**
   * Run a query, retrying once without the optional type field if IGDB says it
   * does not know it. The rejection is remembered, so the cost is one wasted
   * request per process rather than one per lookup.
   */
  private async queryGames(
    build: (fields: string) => string,
    signal?: AbortSignal,
  ): Promise<IgdbGame[]> {
    try {
      return await this.query<IgdbGame>('games', build(this.fields()), signal);
    } catch (error) {
      if (this.typeFieldUsable && isInvalidFieldError(error)) {
        this.typeFieldUsable = false;
        return this.query<IgdbGame>('games', build(this.fields()), signal);
      }
      throw error;
    }
  }

  async search(title: string, limit = 10, signal?: AbortSignal): Promise<IgdbGame[]> {
    const capped = Math.min(Math.max(limit, 1), 50);
    const results = await this.queryGames(
      (fields) => `search ${IgdbClient.quote(title)}; fields ${fields}; limit ${capped};`,
      signal,
    );

    // Main games first when IGDB told us the type, so a base game outranks its
    // own DLC at equal title similarity. Nothing is excluded: an archive of
    // freeware is full of entries IGDB types oddly, and dropping them outright
    // is how a game ends up with no metadata at all.
    return results.slice().sort((a, b) => rankByType(a) - rankByType(b));
  }

  /**
   * What people are playing right now, for the request page's suggestions.
   *
   * IGDB keeps popularity as a separate resource keyed by game id rather than
   * a field on the game, so this is two round trips: the ranking, then the
   * names and covers for the ids it returned. Ranked by Steam's 24-hour peak
   * player count, which is the one primitive that reflects what is actually
   * being played rather than what is being clicked on IGDB itself.
   */
  async popular(limit = 12): Promise<IgdbGame[]> {
    const capped = Math.min(Math.max(limit, 1), 30);

    const ranking = await this.query<{ game_id: number; value: number }>(
      'popularity_primitives',
      // 5 is Steam 24hr peak players. Asking for more than we need leaves room
      // to drop ids IGDB has no game record for.
      `fields game_id,value; where popularity_type = 5; sort value desc; limit ${capped * 2};`,
    );

    const ids = [...new Set(ranking.map((entry) => entry.game_id))].slice(0, capped);
    if (ids.length === 0) return [];

    const games = await this.queryGames(
      (fields) => `fields ${fields}; where id = (${ids.join(',')}); limit ${ids.length};`,
    );

    // IGDB returns the games in its own order, so the ranking is reapplied.
    const rank = new Map(ids.map((id, index) => [id, index]));
    return games
      .slice()
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }

  /**
   * Releases that have not landed yet, ranked by how many people are waiting.
   *
   * `hypes` is IGDB's own count of members who have followed a game before
   * release, which is the closest thing it publishes to "people want this".
   * A dated future release is required so the shelf cannot fill up with
   * announced-but-undated entries that may never arrive.
   */
  async anticipated(limit = 12): Promise<IgdbGame[]> {
    const capped = Math.min(Math.max(limit, 1), 30);
    const now = Math.floor(Date.now() / 1000);
    return this.queryGames(
      (fields) =>
        `fields ${fields}; ` +
        `where first_release_date > ${now} & hypes > 0 & cover != null; ` +
        `sort hypes desc; limit ${capped};`,
    );
  }

  /**
   * What came out recently, ranked by how many people have rated it.
   *
   * Rating *count* rather than rating value: a month-old game with four
   * glowing scores is noise, and what this shelf is for is "did I miss
   * something" rather than "what is good".
   */
  async recentlyReleased(limit = 12): Promise<IgdbGame[]> {
    const capped = Math.min(Math.max(limit, 1), 30);
    const now = Math.floor(Date.now() / 1000);
    const since = now - 120 * 86_400;
    return this.queryGames(
      (fields) =>
        `fields ${fields}; ` +
        `where first_release_date > ${since} & first_release_date < ${now} ` +
        '& total_rating_count > 5 & cover != null; ' +
        `sort total_rating_count desc; limit ${capped};`,
    );
  }

  /**
   * The consistently well regarded, as a shelf that does not move week to week.
   *
   * The rating floor is paired with a vote floor on purpose: IGDB will happily
   * report a perfect score backed by three people, and a shelf of those is
   * worse than no shelf.
   */
  async acclaimed(limit = 12): Promise<IgdbGame[]> {
    const capped = Math.min(Math.max(limit, 1), 30);
    return this.queryGames(
      (fields) =>
        `fields ${fields}; ` +
        'where total_rating > 88 & total_rating_count > 200 & cover != null; ' +
        `sort total_rating desc; limit ${capped};`,
    );
  }

  /**
   * Every image IGDB has for the top matches on a title, for the admin picker.
   *
   * Uses its own narrow field list rather than the shared one: `artworks` is
   * only needed here, and keeping it out of the main list means a change to it
   * can never take down search and matching the way `category` did.
   */
  async images(title: string, limit = 5): Promise<IgdbImage[]> {
    const capped = Math.min(Math.max(limit, 1), 10);
    const query =
      `search ${IgdbClient.quote(title)}; ` +
      'fields name,cover.image_id,artworks.image_id,screenshots.image_id; ' +
      `limit ${capped};`;

    const results = await this.query<IgdbGame & { artworks?: Array<{ image_id?: string }> }>(
      'games',
      query,
    );

    const images: IgdbImage[] = [];
    const seen = new Set<string>();

    const push = (imageId: string | undefined, source: IgdbImage['source'], gameName: string) => {
      if (!imageId || seen.has(imageId)) return;
      seen.add(imageId);
      images.push({ imageId, source, gameName });
    };

    for (const game of results) {
      push(game.cover?.image_id, 'cover', game.name);
      for (const artwork of game.artworks ?? []) push(artwork.image_id, 'artwork', game.name);
      for (const shot of game.screenshots ?? []) push(shot.image_id, 'screenshot', game.name);
    }

    return images;
  }

  async getById(id: number): Promise<IgdbGame | null> {
    const results = await this.queryGames(
      (fields) => `fields ${fields}; where id = ${Math.trunc(id)}; limit 1;`,
    );
    return results[0] ?? null;
  }

  /**
   * Confirms the credentials work *and* that a real search succeeds.
   *
   * A bare `fields id; limit 1;` probe passes even when every search is
   * failing, which is exactly how a broken query stayed invisible: the admin
   * panel reported IGDB healthy while nothing could match. The health check
   * has to exercise the same shape of request the app actually makes.
   */
  async verify(): Promise<void> {
    const results = await this.search('portal', 1);
    if (results.length === 0) {
      throw new HttpError(
        502,
        'IGDB accepted the credentials but returned no results for a known title',
      );
    }
  }
}

/** True for the 400 IGDB returns when a query names a field it does not have. */
function isInvalidFieldError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status !== 400) return false;
  return /invalid field|unexpected.*field|no such field/i.test(error.message);
}

function rankByType(game: IgdbGame): number {
  if (game.game_type === undefined) return 0;
  return game.game_type === MAIN_GAME ? 0 : 1;
}

export function normalizeIgdbGame(game: IgdbGame) {
  const companies = game.involved_companies ?? [];
  const pick = (predicate: (c: IgdbCompany) => boolean | undefined) =>
    Array.from(
      new Set(
        companies
          .filter((c) => predicate(c))
          .map((c) => c.company?.name)
          .filter((n): n is string => Boolean(n)),
      ),
    );

  const ratingSource = game.total_rating ?? game.rating;

  return {
    igdbId: game.id,
    title: game.name,
    summary: game.summary ?? null,
    storyline: game.storyline ?? null,
    releaseDate: game.first_release_date
      ? new Date(game.first_release_date * 1000).toISOString().slice(0, 10)
      : null,
    rating: typeof ratingSource === 'number' ? Math.round(ratingSource) : null,
    developers: pick((c) => c.developer),
    publishers: pick((c) => c.publisher),
    genres: (game.genres ?? []).map((g) => g.name).filter((n): n is string => Boolean(n)),
    platforms: (game.platforms ?? []).map((p) => p.name).filter((n): n is string => Boolean(n)),
    coverUrl: game.cover?.image_id ? igdbImageUrl(game.cover.image_id, 'cover_big') : null,
    screenshotUrls: (game.screenshots ?? [])
      .map((s) => s.image_id)
      .filter((id): id is string => Boolean(id))
      .slice(0, 8)
      .map((id) => igdbImageUrl(id, 'screenshot_big')),
    videoIds: (game.videos ?? [])
      .map((v) => v.video_id)
      .filter((id): id is string => Boolean(id))
      .slice(0, 4),
  };
}

export type NormalizedIgdbGame = ReturnType<typeof normalizeIgdbGame>;
