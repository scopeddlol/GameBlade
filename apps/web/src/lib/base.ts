/**
 * The server rewrites the `<base href>` in index.html to whatever BASE_PATH it
 * was configured with, so a single build works at `/` and at `/gameblade`.
 * Everything that needs a URL derives it from here rather than assuming root.
 */
function readBasePath(): string {
  if (typeof document === 'undefined') return '';
  try {
    const pathname = new URL(document.baseURI).pathname;
    const trimmed = pathname.replace(/\/+$/, '');
    return trimmed === '/' ? '' : trimmed;
  } catch {
    return '';
  }
}

export const BASE_PATH = readBasePath();

/** Router basename; React Router expects '/' rather than '' for the root. */
export const ROUTER_BASENAME = BASE_PATH === '' ? '/' : BASE_PATH;

export const API_BASE = `${BASE_PATH}/api`;

/** Absolute path for a server-provided URL that is already base-prefixed. */
export function assetUrl(url: string | null): string | undefined {
  return url ?? undefined;
}
