import { HttpError, RateLimiter, withRetry } from '../../lib/ratelimit.js';

const API_URL = 'https://www.steamgriddb.com/api/v2';

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

  private async request<T>(path: string): Promise<T | null> {
    return withRetry(() =>
      this.limiter.run(async () => {
        const response = await fetch(`${API_URL}${path}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
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

  async search(term: string): Promise<SgdbGame[]> {
    const data = await this.request<SgdbGame[]>(`/search/autocomplete/${encodeURIComponent(term)}`);
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
  ): Promise<SgdbAsset[]> {
    const params = new URLSearchParams({ nsfw: 'false', humor: 'false', ...query });
    const data = await this.request<SgdbAsset[]>(`/${kind}/game/${gameId}?${params.toString()}`);
    return (data ?? []).slice().sort((a, b) => b.score - a.score);
  }

  /** Vertical 600x900 / 342x482 style poster used by the library grid. */
  grids(gameId: number) {
    return this.assets('grids', gameId, { dimensions: '600x900,342x482' });
  }

  /** Wide banner behind the game detail page. */
  heroes(gameId: number) {
    return this.assets('heroes', gameId);
  }

  logos(gameId: number) {
    return this.assets('logos', gameId);
  }

  icons(gameId: number) {
    return this.assets('icons', gameId);
  }

  async verify(): Promise<void> {
    await this.search('portal');
  }
}
