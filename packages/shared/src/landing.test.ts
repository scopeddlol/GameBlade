import { describe, expect, it } from 'vitest';
import {
  defaultLandingBlocks,
  landingBlockSchema,
  landingPageSchema,
  youtubeId,
} from './landing.js';

/**
 * The landing page is stored as data an operator edited months ago and parsed
 * on every request to the front door. So the two things worth pinning down are
 * that a block written before a field existed still parses, and that a block
 * with something unexpected in it fails loudly rather than reaching the page.
 */
describe('landingBlockSchema', () => {
  it('fills in the rhythm settings a block stored before them has never heard of', () => {
    // Exactly what is in the settings row of a server that has been running
    // since before padding, background and width were block-level choices.
    const parsed = landingBlockSchema.parse({
      id: 'hero',
      kind: 'hero',
      visible: true,
      headline: 'Hello',
      subheadline: '',
      showDownload: true,
      showRegister: true,
      backgroundUrl: '',
    });

    expect(parsed).toMatchObject({
      padding: 'normal',
      background: 'none',
      width: 'normal',
      // The hero's own later additions default too.
      eyebrow: '',
      align: 'left',
      height: 'normal',
      overlay: 60,
    });
  });

  it('rejects a surface that is not one of the theme-derived ones', () => {
    // The point of naming these by role is that every one works under a light
    // theme; a free-form colour would be a hole in a pale page.
    const parse = () =>
      landingBlockSchema.parse({ id: 'q', kind: 'quote', quote: 'Hi', background: '#000' });
    expect(parse).toThrow();
  });

  it('keeps the hero overlay inside a range that stays readable', () => {
    const overlaid = (overlay: number) =>
      landingBlockSchema.parse({ id: 'h', kind: 'hero', overlay });
    expect(() => overlaid(-10)).toThrow();
    expect(() => overlaid(120)).toThrow();
    expect(overlaid(0)).toMatchObject({ overlay: 0 });
  });

  it('parses every kind the palette offers', () => {
    // A kind in the palette with no schema behind it would be a button that
    // adds a block the server then refuses to save.
    for (const block of defaultLandingBlocks()) {
      expect(() => landingBlockSchema.parse(block)).not.toThrow();
    }
    for (const kind of ['steps', 'video', 'quote', 'faq', 'divider'] as const) {
      expect(() => landingBlockSchema.parse({ id: kind, kind })).not.toThrow();
    }
  });

  it('caps how many sections one page can hold', () => {
    const many = Array.from({ length: 31 }, (_, index) => ({ id: `d${index}`, kind: 'divider' }));
    expect(() => landingPageSchema.parse({ blocks: many })).toThrow();
  });
});

/**
 * The video block frames one host and one host only, because that is the only
 * host the page's content security policy allows. Everything else has to come
 * back null so the block renders as nothing rather than as a blocked frame.
 */
describe('youtubeId', () => {
  it('reads the id out of every link people actually paste', () => {
    const cases = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      '  dQw4w9WgXcQ  ',
    ];
    for (const value of cases) {
      expect(youtubeId(value), value).toBe('dQw4w9WgXcQ');
    }
  });

  it('refuses anything that is not YouTube', () => {
    for (const value of [
      '',
      'https://vimeo.com/123456',
      'https://example.invalid/watch?v=dQw4w9WgXcQ',
      'not a url',
    ]) {
      expect(youtubeId(value), value).toBeNull();
    }
  });
});
