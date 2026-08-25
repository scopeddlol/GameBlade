/**
 * Token bucket with a concurrency ceiling.
 *
 * IGDB allows 4 requests per second and at most 8 in flight; exceeding either
 * returns 429. Gating every outbound call through this keeps a large first scan
 * from tripping the limit and stalling metadata for the whole library.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly ratePerSecond: number,
    private readonly maxConcurrent: number,
  ) {
    this.tokens = ratePerSecond;
  }

  async acquire(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });

    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.pump();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
  }

  private pump(): void {
    this.refill();

    while (this.queue.length > 0 && this.tokens >= 1 && this.inFlight < this.maxConcurrent) {
      this.tokens -= 1;
      const next = this.queue.shift();
      next?.();
    }

    if (this.queue.length > 0 && this.timer === null) {
      const waitMs =
        this.tokens >= 1 ? 25 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000) + 5;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, waitMs);
      // Never hold the process open just to drain this queue.
      this.timer.unref?.();
    }
  }

  private timer: NodeJS.Timeout | null = null;
}

/**
 * How long an outbound provider call may take before it is abandoned.
 *
 * `fetch` has no total deadline of its own, so a connection that opens and then
 * goes quiet occupies its slot until the runtime's own long default gives up.
 * During a scan that is indistinguishable from a hang: the run sits on one
 * title with nothing in the log. A request that has not completed in this long
 * is not going to.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** The same, for artwork — a whole image body rather than a page of JSON. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry with exponential backoff, honouring an upstream `Retry-After` header. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      options.onRetry?.(error, attempt);
      const retryAfter = retryAfterMs(error);
      await sleep(retryAfter ?? baseDelay * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // An abandoned request is worth one more go: the usual cause is a provider
  // being briefly slow rather than the request being unanswerable.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  // Network-level failures (DNS, reset, timeout) are worth another try.
  return error instanceof TypeError || (error as { code?: string })?.code !== undefined;
}

function retryAfterMs(error: unknown): number | null {
  if (error instanceof HttpError && error.retryAfterSeconds !== undefined) {
    return Math.min(error.retryAfterSeconds * 1000, 30_000);
  }
  return null;
}
