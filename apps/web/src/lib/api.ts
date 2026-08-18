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
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * Uploads a file as a raw request body, reporting progress as it goes.
 *
 * Built on XMLHttpRequest rather than fetch on purpose: a client installer is
 * hundreds of megabytes, and fetch still has no upload-progress event, so the
 * page would sit on a spinner with no indication of whether anything is
 * happening for minutes at a time.
 */
export function uploadFile<T>(
  path: string,
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}${path}`, true);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (csrfToken) request.setRequestHeader(CSRF_HEADER, csrfToken);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    });

    const fail = (status: number, code: string, message: string) =>
      reject(new ApiRequestError(status, code, message));

    request.addEventListener('load', () => {
      let payload: unknown = null;
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(payload as T);
        return;
      }
      const info = (payload as ApiErrorBody | null)?.error;
      fail(
        request.status,
        info?.code ?? 'unknown_error',
        info?.message ?? `Upload failed with status ${request.status}`,
      );
    });

    request.addEventListener('error', () =>
      fail(0, 'network_error', 'The upload failed. Check the connection and try again.'),
    );
    request.addEventListener('abort', () => fail(0, 'aborted', 'The upload was cancelled.'));

    options.signal?.addEventListener('abort', () => request.abort());
    request.send(file);
  });
}

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
