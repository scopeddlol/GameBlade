import { CSRF_HEADER, type ApiErrorBody } from '@gameblade/shared';
import { API_BASE } from './base.js';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * The CSRF token comes back with the session and must accompany every
 * state-changing request. It is held in memory only — putting it in
 * localStorage would hand it to any script that manages to run on the page.
 */
let csrfToken = '';

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function getCsrfToken(): string {
  return csrfToken;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Suppress the automatic redirect-to-login on a 401. */
  allowUnauthorized?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, allowUnauthorized: _allowUnauthorized, ...rest } = options;
  const method = rest.method ?? 'GET';

  const finalHeaders = new Headers(headers);
  if (body !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) {
    finalHeaders.set(CSRF_HEADER, csrfToken);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    method,
    headers: finalHeaders,
    // Session cookie must ride along, including behind a reverse proxy.
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload: unknown = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody;
    const info = errorBody?.error;
    throw new ApiRequestError(
      response.status,
      info?.code ?? 'unknown_error',
      info?.message ?? `Request failed with status ${response.status}`,
      info?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

/** Build a query string, omitting empty values so URLs stay readable. */
export function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
