import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The running server's version.
 *
 * Read from the bundled package.json rather than `npm_package_version`, which
 * only exists when the process was started by a package manager — the image
 * runs `node dist/index.js` directly, so relying on it reported the fallback
 * on every real deployment.
 */
function read(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'version' in parsed) {
        const value = (parsed as { version: unknown }).version;
        if (typeof value === 'string' && value.length > 0) return value;
      }
    } catch {
      // Try the next candidate; a missing manifest is not fatal.
    }
  }
  return process.env.npm_package_version ?? 'unknown';
}

/** Resolved once: the manifest cannot change under a running process. */
export const VERSION = read();
