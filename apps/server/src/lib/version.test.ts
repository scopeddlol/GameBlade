import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

/**
 * The health probe is how an operator confirms an upgrade actually landed, so
 * the version it reports has to be the version that is running.
 */
describe('VERSION', () => {
  it('matches the package manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(VERSION).toBe(manifest.version);
  });

  it('does not fall back', () => {
    // The previous implementation read npm_package_version, which is unset when
    // the image runs `node dist/index.js` — so every deployment reported the
    // fallback instead of its real version.
    expect(VERSION).not.toBe('unknown');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
