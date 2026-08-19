import { z } from 'zod';

/**
 * The landing page as data.
 *
 * Blocks rather than free-form positioning: an operator gets to say what the
 * page contains and in what order, while the layout of each section stays
 * something that was designed once and works at every width. A drag-anywhere
 * canvas would trade that for a page that breaks on a phone.
 */

export const LANDING_BLOCK_KINDS = ['hero', 'features', 'stats', 'gallery', 'text', 'cta'] as const;
export type LandingBlockKind = (typeof LANDING_BLOCK_KINDS)[number];

/** Icons a feature card can wear, resolved to components client-side. */
export const LANDING_ICONS = [
  'archive',
  'cloud-upload',
  'gamepad',
  'sparkles',
  'swords',
  'trophy',
  'users',
  'shield',
  'download',
  'zap',
] as const;

const icon = z.enum(LANDING_ICONS).default('sparkles');

const baseBlock = {
  id: z.string().trim().min(1).max(64),
  /** Hidden blocks stay in the list so a section can be parked, not deleted. */
  visible: z.boolean().default(true),
};

export const heroBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('hero'),
  /** Blank falls back to the server name, so the common case needs no editing. */
  headline: z.string().trim().max(120).default(''),
  subheadline: z.string().trim().max(400).default(''),
  /** The download button is shown only when a client build is published. */
  showDownload: z.boolean().default(true),
  showRegister: z.boolean().default(true),
  /** An image URL behind the hero; blank uses the gradient. */
  backgroundUrl: z.string().trim().max(1000).default(''),
});

export const featuresBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('features'),
  title: z.string().trim().max(120).default(''),
  items: z
    .array(
      z.object({
        icon,
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().max(400).default(''),
      }),
    )
    .max(12)
    .default([]),
});

export const statsBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('stats'),
  title: z.string().trim().max(120).default(''),
  /** Real counts from the server, rather than numbers typed in by hand. */
  showGameCount: z.boolean().default(true),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        value: z.string().trim().min(1).max(40),
      }),
    )
    .max(8)
    .default([]),
});

export const galleryBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('gallery'),
  title: z.string().trim().max(120).default(''),
  images: z
    .array(
      z.object({
        url: z.string().trim().min(1).max(1000),
        caption: z.string().trim().max(120).default(''),
      }),
    )
    .max(12)
    .default([]),
});

export const textBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('text'),
  title: z.string().trim().max(120).default(''),
  /** Plain text; paragraphs split on blank lines. No HTML is ever rendered. */
  body: z.string().trim().max(4000).default(''),
  align: z.enum(['left', 'center']).default('left'),
});

export const ctaBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('cta'),
  title: z.string().trim().max(120).default(''),
  body: z.string().trim().max(400).default(''),
  showDownload: z.boolean().default(true),
  showRegister: z.boolean().default(true),
});

export const landingBlockSchema = z.discriminatedUnion('kind', [
  heroBlockSchema,
  featuresBlockSchema,
  statsBlockSchema,
  galleryBlockSchema,
  textBlockSchema,
  ctaBlockSchema,
]);
export type LandingBlock = z.infer<typeof landingBlockSchema>;

export const landingPageSchema = z.object({
  blocks: z.array(landingBlockSchema).max(30),
});
export type LandingPageInput = z.infer<typeof landingPageSchema>;

/** Human labels for the block palette in the editor. */
export const LANDING_BLOCK_LABELS: Record<LandingBlockKind, string> = {
  hero: 'Hero',
  features: 'Feature grid',
  stats: 'Stats',
  gallery: 'Screenshots',
  text: 'Text',
  cta: 'Call to action',
};

export const LANDING_BLOCK_HINTS: Record<LandingBlockKind, string> = {
  hero: 'The headline at the top, with the download and sign-up buttons.',
  features: 'A grid of short "what you get" cards.',
  stats: 'A strip of numbers. Can pull the real game count from the server.',
  gallery: 'A row of screenshots or artwork.',
  text: 'A block of prose. Blank lines start new paragraphs.',
  cta: 'A closing prompt with the same buttons as the hero.',
};

/**
 * What a server shows before anyone has edited anything.
 *
 * Deliberately a faithful copy of the hand-written page this replaced, so
 * turning the editor on changes nothing until an operator chooses to change
 * something.
 */
export function defaultLandingBlocks(): LandingBlock[] {
  return [
    {
      id: 'hero',
      kind: 'hero',
      visible: true,
      headline: '',
      subheadline: '',
      showDownload: true,
      showRegister: true,
      backgroundUrl: '',
    },
    {
      id: 'features',
      kind: 'features',
      visible: true,
      title: 'Everything in one place',
      items: [
        {
          icon: 'archive',
          title: 'A library that keeps',
          body: 'Every game stays exactly as you archived it, with the artwork and metadata to match.',
        },
        {
          icon: 'download',
          title: 'Downloads that resume',
          body: 'Parallel, resumable transfers with checksums, so a dropped connection costs seconds.',
        },
        {
          icon: 'cloud-upload',
          title: 'Saves that follow you',
          body: 'Cloud saves sync before you play and after you quit, with conflicts surfaced rather than guessed.',
        },
        {
          icon: 'trophy',
          title: 'Achievements',
          body: 'Imported from published schemas, tracked per player, and shown off to friends.',
        },
        {
          icon: 'users',
          title: 'Friends and presence',
          body: 'See who is online, what they are playing, and what they have just unlocked.',
        },
        {
          icon: 'shield',
          title: 'Invite only',
          body: 'Nobody signs up without a code you handed out. It is your archive.',
        },
      ],
    },
    {
      id: 'stats',
      kind: 'stats',
      visible: true,
      title: '',
      showGameCount: true,
      items: [],
    },
    {
      id: 'cta',
      kind: 'cta',
      visible: true,
      title: 'Get the client',
      body: 'The Windows app is where the library actually lives.',
      showDownload: true,
      showRegister: true,
    },
  ];
}
