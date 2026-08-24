import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CSRF_HEADER,
  THEMES,
  defaultLandingBlocks,
  type LandingBlock,
  type PublicServerInfo,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

interface LandingResponse {
  blocks: LandingBlock[];
  isCustomised: boolean;
}

/**
 * Theming and the landing-page editor.
 *
 * The landing page is the server's front door and the one route an
 * unauthenticated visitor hits, so most of what matters is that bad stored
 * data degrades rather than 500s.
 */
describe('appearance', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-look-test-'));
    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    const raw = setup.headers['set-cookie'];
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (setup.json() as { csrfToken: string }).csrfToken,
    };
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- theme */

  it('serves the default theme to an unauthenticated visitor', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/public/info' });
    const body = response.json() as PublicServerInfo;

    expect(body.theme.preset).toBe('midnight');
    expect(body.theme.tokens.accent500).toBe(THEMES.midnight.tokens.accent500);
    // The landing page renders before anyone logs in, so it must arrive here.
    expect(body.landingBlocks.length).toBeGreaterThan(0);
  });

  it('changes the theme and reflects it publicly', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/theme',
      headers: auth(),
      payload: { preset: 'daylight' },
    });
    expect(saved.statusCode).toBe(200);

    const info = (
      await app.inject({ method: 'GET', url: '/api/public/info' })
    ).json() as PublicServerInfo;
    expect(info.theme.preset).toBe('daylight');
    // A light theme must actually say so, or the client keeps dark widgets.
    expect(info.theme.tokens.scheme).toBe('light');
  });

  it('derives the lighter and darker accent steps from an override', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/theme',
      headers: auth(),
      payload: { preset: 'midnight', accent: '#ff0066' },
    });

    const body = response.json() as { tokens: Record<string, string> };
    expect(body.tokens.accent500).toBe('#ff0066');
    // Asking an operator to pick four related colours by hand is how a theme
    // ends up with a hover state that vanishes.
    expect(body.tokens.accent400).not.toBe(body.tokens.accent500);
    expect(body.tokens.accent600).not.toBe(body.tokens.accent500);
  });

  it('rejects a preset it does not ship and a malformed accent', async () => {
    for (const payload of [
      { preset: 'hot-pink' },
      { preset: 'midnight', accent: 'red' },
      { preset: 'midnight', accent: '#fff' },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/theme',
        headers: auth(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('keeps theming away from anyone not signed in', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/theme',
      payload: { preset: 'carbon' },
    });
    expect(response.statusCode).toBe(401);
  });

  /* -------------------------------------------------------------- landing */

  /**
   * The built-in page's block sequence.
   *
   * Taken from the definition rather than spelled out, so composing a better
   * default page is not a three-site test failure. What these assertions are
   * actually about is that the endpoint hands back the built-in page rather
   * than saved blocks, an empty list or an error — so the anchors below are
   * what keep a defaults function that returned nothing from passing.
   */
  const builtInKinds = () => {
    const kinds = defaultLandingBlocks().map((block) => block.kind);
    expect(kinds.length).toBeGreaterThan(2);
    expect(kinds[0]).toBe('hero');
    expect(kinds.at(-1)).toBe('cta');
    return kinds;
  };

  it('starts from the built-in page and reports it as uncustomised', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/landing',
      headers: auth(),
    });
    const body = response.json() as LandingResponse;

    expect(body.isCustomised).toBe(false);
    expect(body.blocks.map((block) => block.kind)).toEqual(builtInKinds());
  });

  it('saves an edited page and serves it publicly', async () => {
    const blocks: LandingBlock[] = [
      {
        id: 'hero',
        kind: 'hero',
        visible: true,
        headline: 'Welcome to the Archive',
        subheadline: 'Ours, not theirs.',
        showDownload: true,
        showRegister: false,
        backgroundUrl: '',
      },
      {
        id: 'note',
        kind: 'text',
        visible: true,
        title: 'House rules',
        body: 'Be kind.\n\nShare well.',
        align: 'left',
      },
    ];

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/landing',
      headers: auth(),
      payload: { blocks },
    });
    expect(saved.statusCode).toBe(200);

    const info = (
      await app.inject({ method: 'GET', url: '/api/public/info' })
    ).json() as PublicServerInfo;
    expect(info.landingBlocks).toHaveLength(2);
    expect(info.landingBlocks[0]).toMatchObject({
      kind: 'hero',
      headline: 'Welcome to the Archive',
    });
  });

  it('keeps a hidden block in the payload for the client to skip', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/landing',
      headers: auth(),
      payload: {
        blocks: [
          {
            id: 'hero',
            kind: 'hero',
            visible: false,
            headline: 'Parked',
            subheadline: '',
            showDownload: true,
            showRegister: true,
            backgroundUrl: '',
          },
        ],
      },
    });

    const info = (
      await app.inject({ method: 'GET', url: '/api/public/info' })
    ).json() as PublicServerInfo;
    // Hiding is not deleting: the block survives so it can be brought back.
    expect(info.landingBlocks[0]).toMatchObject({ visible: false });
  });

  it('rejects a block whose shape is wrong', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/landing',
      headers: auth(),
      payload: { blocks: [{ id: 'x', kind: 'not-a-block', visible: true }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('falls back to the default page rather than 500ing on unreadable data', async () => {
    // Exactly what an older or hand-edited settings row could contain. The
    // landing page is the front door — it must degrade, not fail.
    app.gameblade.settings.update({ landingBlocks: [{ kind: 'from-the-future' }] });

    const response = await app.inject({ method: 'GET', url: '/api/public/info' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as PublicServerInfo;
    expect(body.landingBlocks.map((block) => block.kind)).toEqual(builtInKinds());
  });

  it('reverts to the built-in page on reset', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/landing',
      headers: auth(),
      payload: {
        blocks: [
          {
            id: 'only',
            kind: 'text',
            visible: true,
            title: 'Temporary',
            body: '',
            align: 'left',
          },
        ],
      },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/admin/landing/reset',
      headers: auth(),
    });
    expect((reset.json() as LandingResponse).isCustomised).toBe(false);

    const after = (
      await app.inject({ method: 'GET', url: '/api/admin/landing', headers: auth() })
    ).json() as LandingResponse;
    expect(after.blocks.map((block) => block.kind)).toEqual(builtInKinds());
  });
});
