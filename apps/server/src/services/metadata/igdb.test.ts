import { afterEach, describe, expect, it, vi } from 'vitest';
import { IgdbClient } from './igdb.js';

/**
 * These cover the failure that took the whole metadata pipeline down: IGDB
 * renamed `category` to `game_type`, the old name started returning "Invalid
 * Field", and every search 400'd while the health check still reported green.
 */
describe('IgdbClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs the token endpoint plus a scripted sequence of /games responses. */
  function stubIgdb(handlers: Array<(body: string) => Response>) {
    let call = 0;
    const bodies: string[] = [];

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('id.twitch.tv')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = String(init?.body ?? '');
      bodies.push(body);
      const handler = handlers[Math.min(call, handlers.length - 1)];
      call += 1;
      return handler(body);
    });

    vi.stubGlobal('fetch', fetchMock);
    return { bodies };
  }

  const ok = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const invalidField = () =>
    new Response('{"title":"Syntax Error","cause":"Invalid Field"}', { status: 400 });

  it('never sends the deprecated category field', async () => {
    const { bodies } = stubIgdb([() => ok([{ id: 1, name: 'Portal' }])]);

    await new IgdbClient('id', 'secret').search('portal');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('category');
  });

  it('retries without the optional type field when IGDB rejects it', async () => {
    // First attempt carries game_type and is refused; the retry must drop it
    // rather than surfacing the error, or one rename breaks every lookup.
    const { bodies } = stubIgdb([invalidField, () => ok([{ id: 7, name: 'Celeste' }])]);

    const results = await new IgdbClient('id', 'secret').search('celeste');

    expect(results.map((g) => g.name)).toEqual(['Celeste']);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('game_type');
    expect(bodies[1]).not.toContain('game_type');
  });

  it('stops re-sending the type field once it has been rejected', async () => {
    const { bodies } = stubIgdb([invalidField, () => ok([{ id: 1, name: 'A' }])]);
    const client = new IgdbClient('id', 'secret');

    await client.search('a');
    await client.search('b');

    // Three requests total: the rejected probe, its retry, then a second search
    // that already knows not to ask.
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toContain('game_type');
  });

  it('ranks main games above other entries when the type is known', async () => {
    stubIgdb([
      () =>
        ok([
          { id: 2, name: 'Portal 2: DLC', game_type: 1 },
          { id: 1, name: 'Portal 2', game_type: 0 },
        ]),
    ]);

    const results = await new IgdbClient('id', 'secret').search('portal 2');
    expect(results.map((g) => g.id)).toEqual([1, 2]);
  });

  it('keeps entries whose type is unknown rather than dropping them', async () => {
    // An archive of freeware is full of oddly typed entries; excluding them is
    // how a game ends up with no metadata at all.
    stubIgdb([() => ok([{ id: 5, name: 'Some Freeware Thing', game_type: 3 }])]);

    const results = await new IgdbClient('id', 'secret').search('some freeware thing');
    expect(results).toHaveLength(1);
  });

  it('fails verification when a real search comes back empty', async () => {
    // A bare `fields id; limit 1;` probe passed even while every search was
    // broken, which is how the outage stayed invisible in the admin panel.
    stubIgdb([() => ok([])]);

    await expect(new IgdbClient('id', 'secret').verify()).rejects.toThrow(/no results/i);
  });

  it('propagates a genuine failure instead of retrying forever', async () => {
    stubIgdb([() => new Response('nope', { status: 403 })]);

    await expect(new IgdbClient('id', 'secret').search('x')).rejects.toThrow(/403/);
  });
});

describe('IgdbClient.images', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collects covers, artworks and screenshots without duplicates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('id.twitch.tv')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'Portal',
              cover: { image_id: 'cov1' },
              artworks: [{ image_id: 'art1' }, { image_id: 'art2' }],
              screenshots: [{ image_id: 'art1' }, { image_id: 'shot1' }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const images = await new IgdbClient('id', 'secret').images('portal');

    // art1 appears as both an artwork and a screenshot; it must be offered once.
    expect(images.map((i) => i.imageId)).toEqual(['cov1', 'art1', 'art2', 'shot1']);
    expect(images[0]?.source).toBe('cover');
  });
});
