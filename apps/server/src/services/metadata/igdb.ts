import { HttpError, RateLimiter, withRetry } from '../../lib/ratelimit.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_URL = 'https://api.igdb.com/v4';

/** IGDB serves every asset from one CDN; `t_*` selects the rendition. */
export function igdbImageUrl(
  imageId: string,
  size: 'cover_big' | '1080p' | 'screenshot_big' | 'thumb',
): string {
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
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
}

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

export class IgdbClient {
  /** 4 requests/second, 8 concurrent — the documented IGDB ceiling. */
  private readonly limiter = new RateLimiter(4, 8);
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;

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

    const response = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: 'POST' });
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

  private async query<T>(endpoint: string, apicalypse: string): Promise<T[]> {
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

  async search(title: string, limit = 10): Promise<IgdbGame[]> {
    const query = [
      `search ${IgdbClient.quote(title)};`,
      `fields ${GAME_FIELDS};`,
      // Exclude DLC/expansions/bundles so a base game wins the match.
      'where category = (0,4,8,9);',
      `limit ${Math.min(Math.max(limit, 1), 50)};`,
    ].join(' ');
    return this.query<IgdbGame>('games', query);
  }

  async getById(id: number): Promise<IgdbGame | null> {
    const results = await this.query<IgdbGame>(
      'games',
      `fields ${GAME_FIELDS}; where id = ${Math.trunc(id)}; limit 1;`,
    );
    return results[0] ?? null;
  }

  /** Cheap call used by the admin UI to confirm the credentials work. */
  async verify(): Promise<void> {
    await this.query('games', 'fields id; limit 1;');
  }
}

export function normaliseIgdbGame(game: IgdbGame) {
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

export type NormalisedIgdbGame = ReturnType<typeof normaliseIgdbGame>;
