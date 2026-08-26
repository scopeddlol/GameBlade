import {
  HttpError,
  REQUEST_TIMEOUT_MS,
  RateLimiter,
  requestSignal,
  withRetry,
} from '../../lib/ratelimit.js';

const API_URL = 'https://www.steamgriddb.com/api/v2';

/** The two wide capsule sizes Steam itself uses, largest first. */
const BANNER_DIMENSIONS = '920x430,460x215';

export interface SgdbGame {
  id: number;
  name: string;
  release_date?: number;
}

export interface SgdbAsset {
  id: number;
  score: number;
  url: string;
  thumb: string;
  width: number;
  height: number;
  style?: string;
  nsfw?: boolean;
  humor?: boolean;
}

interface SgdbResponse<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

/**
 * SteamGridDB publishes no hard rate limit, so we self-impose a modest one
 * rather than hammering a free community service during a first-time scan.
 */
export class SteamGridDbClient {
  private readonly limiter = new RateLimiter(6, 4);

  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    return withRetry(() =>
      this.limiter.run(async () => {
        const response = await fetch(`${API_URL}${path}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: requestSignal(REQUEST_TIMEOUT_MS, signal),
        });

        // A game with no artwork of a given kind is a normal, non-exceptional result.
        if (response.status === 404) return null;

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new HttpError(
            response.status,
            `SteamGridDB ${path} failed (${response.status})`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          );
        }

        const body = (await response.json()) as SgdbResponse<T>;
        if (!body.success) {
          throw new HttpError(502, `SteamGridDB error: ${body.errors?.join(', ') ?? 'unknown'}`);
        }
        return body.data ?? null;
      }),
    );
  }

  async search(term: string, signal?: AbortSignal): Promise<SgdbGame[]> {
    const data = await this.request<SgdbGame[]>(
      `/search/autocomplete/${encodeURIComponent(term)}`,
      signal,
    );
    return data ?? [];
  }

  /**
   * Assets are requested newest-first with humour and NSFW excluded, then sorted
   * by community score so the best artwork lands on the poster grid.
   */
  private async assets(
    kind: 'grids' | 'heroes' | 'logos' | 'icons',
    gameId: number,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<SgdbAsset[]> {
    const params = new URLSearchParams({ nsfw: 'false', humor: 'false', ...query });
    const data = await this.request<SgdbAsset[]>(
      `/${kind}/game/${gameId}?${params.toString()}`,
      signal,
    );
    return (data ?? []).slice().sort((a, b) => b.score - a.score);
  }

  /**
   * Poster art for the library grid.
   *
   * The exact Steam poster dimensions are preferred, but a game whose only
   * artwork is, say, 660x930 should still get a cover rather than none — so a
   * miss falls back to every grid, portrait first. Filtering on dimensions
   * alone silently returns an empty list, which reads as "no artwork exists".
   */
  async grids(gameId: number, signal?: AbortSignal): Promise<SgdbAsset[]> {
    const posters = await this.assets('grids', gameId, { dimensions: '600x900,342x482' }, signal);
    if (posters.length > 0) return posters;

    const all = await this.assets('grids', gameId, {}, signal);
    return all.slice().sort((a, b) => portraitRank(a) - portraitRank(b) || b.score - a.score);
  }

  /** Wide banner behind the game detail page. */
  heroes(gameId: number, signal?: AbortSignal) {
    return this.assets('heroes', gameId, {}, signal);
  }

  logos(gameId: number, signal?: AbortSignal) {
    return this.assets('logos', gameId, {}, signal);
  }

  icons(gameId: number, signal?: AbortSignal) {
    return this.assets('icons', gameId, {}, signal);
  }

  /** Wide Steam capsules, for the banner slot. */
  async banners(gameId: number, signal?: AbortSignal): Promise<SgdbAsset[]> {
    const wide = await this.assets('grids', gameId, { dimensions: BANNER_DIMENSIONS }, signal);
    if (wide.length > 0) return wide;

    const all = await this.assets('grids', gameId, {}, signal);
    return all.slice().sort((a, b) => landscapeRank(a) - landscapeRank(b) || b.score - a.score);
  }

  /**
   * Every asset of a kind for the admin picker, optionally narrowed to one
   * style or set of dimensions.
   *
   * Distinct from `grids()` on purpose: the automatic path wants one sensible
   * poster, whereas someone choosing by hand wants to see everything on offer,
   * including the wide capsules a poster slot would normally reject.
   */
  browse(
    kind: 'grids' | 'heroes' | 'logos' | 'icons',
    gameId: number,
    options: { style?: string | null; dimensions?: string } = {},
  ): Promise<SgdbAsset[]> {
    const query: Record<string, string> = {};
    if (options.style) query.styles = options.style;
    if (options.dimensions) query.dimensions = options.dimensions;
    return this.assets(kind, gameId, query);
  }

  async verify(): Promise<void> {
    await this.search('portal');
  }
}

/** Taller-than-wide art sorts first; a wide capsule in a poster slot looks wrong. */
function portraitRank(asset: SgdbAsset): number {
  return asset.height > asset.width ? 0 : 1;
}

/** The mirror of portraitRank, for the banner slot. */
function landscapeRank(asset: SgdbAsset): number {
  return asset.width > asset.height ? 0 : 1;
}
