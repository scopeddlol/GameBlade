import { z } from 'zod';

/**
 * The landing page as data.
 *
 * Blocks rather than free-form positioning: an operator gets to say what the
 * page contains and in what order, while the layout of each section stays
 * something that was designed once and works at every width. A drag-anywhere
 * canvas would trade that for a page that breaks on a phone.
 */

export const LANDING_BLOCK_KINDS = [
  'hero',
  'features',
  'steps',
  'stats',
  'gallery',
  'video',
  'quote',
  'faq',
  'text',
  'divider',
  'cta',
] as const;
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

/** How much vertical room a section takes. */
export const LANDING_PADDINGS = ['compact', 'normal', 'roomy'] as const;
export type LandingPadding = (typeof LANDING_PADDINGS)[number];

/**
 * The surface a section sits on.
 *
 * Named by role rather than by colour so every option stays correct under
 * every theme, including the light ones — a block that hard-coded a dark fill
 * would be a hole in a pale page.
 */
export const LANDING_BACKGROUNDS = ['none', 'muted', 'accent'] as const;
export type LandingBackground = (typeof LANDING_BACKGROUNDS)[number];

/** How wide the content inside a section runs. */
export const LANDING_WIDTHS = ['narrow', 'normal', 'wide'] as const;
export type LandingWidth = (typeof LANDING_WIDTHS)[number];

/**
 * Every section's shared knobs.
 *
 * Rhythm is what separates a page that looks designed from a stack of boxes,
 * and rhythm is exactly what an operator cannot get at by editing copy. These
 * three are enough to alternate surfaces, tighten a run of short sections and
 * let one section breathe, without offering a free-form canvas that would
 * break at some width nobody tested.
 *
 * All defaulted, so every block stored before they existed still parses.
 */
const baseBlock = {
  id: z.string().trim().min(1).max(64),
  /** Hidden blocks stay in the list so a section can be parked, not deleted. */
  visible: z.boolean().default(true),
  padding: z.enum(LANDING_PADDINGS).default('normal'),
  background: z.enum(LANDING_BACKGROUNDS).default('none'),
  width: z.enum(LANDING_WIDTHS).default('normal'),
};

/** How many across a grid section runs at its widest. */
export const LANDING_COLUMNS = [2, 3, 4] as const;
const columns = z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3);

export const heroBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('hero'),
  /** A short line above the headline — "self-hosted", "invite only". */
  eyebrow: z.string().trim().max(60).default(''),
  /** Blank falls back to the server name, so the common case needs no editing. */
  headline: z.string().trim().max(120).default(''),
  subheadline: z.string().trim().max(400).default(''),
  /** The download button is shown only when a client build is published. */
  showDownload: z.boolean().default(true),
  showRegister: z.boolean().default(true),
  /** An image URL behind the hero; blank uses the gradient. */
  backgroundUrl: z.string().trim().max(1000).default(''),
  /**
   * How much the background is dimmed, as a percentage.
   *
   * A hero image is behind text that has to stay readable, and how dark an
   * image is varies wildly. Without this an operator's only options were a
   * washed-out image or an unreadable headline.
   */
  overlay: z.number().int().min(0).max(90).default(60),
  align: z.enum(['left', 'center']).default('left'),
  height: z.enum(['compact', 'normal', 'tall', 'full']).default('normal'),
});

export const featuresBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('features'),
  title: z.string().trim().max(120).default(''),
  /** One line under the title, for context the cards should not have to carry. */
  subtitle: z.string().trim().max(300).default(''),
  columns,
  /** Cards read as objects; plain lets a long list breathe. */
  style: z.enum(['card', 'plain']).default('card'),
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

/**
 * A numbered sequence — get an invite, install the client, play.
 *
 * The one thing a landing page for an invite-only server has to explain, and
 * the one shape a feature grid is wrong for: a grid says "these are unordered
 * and equal", which is the opposite of what a set of steps means.
 */
export const stepsBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('steps'),
  title: z.string().trim().max(120).default(''),
  subtitle: z.string().trim().max(300).default(''),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().max(400).default(''),
      }),
    )
    .max(6)
    .default([]),
});

export const statsBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('stats'),
  title: z.string().trim().max(120).default(''),
  /** Real counts from the server, rather than numbers typed in by hand. */
  showGameCount: z.boolean().default(true),
  style: z.enum(['card', 'plain']).default('card'),
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
  columns,
  /** Screenshots are 16:9; cover art is not, and cropping it looks like a bug. */
  ratio: z.enum(['video', 'square', 'portrait', 'wide']).default('video'),
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

/**
 * One embedded YouTube video.
 *
 * YouTube only, because the page's content security policy frames that one
 * host and nothing else. Anything else stored here renders as nothing rather
 * than as a blocked frame.
 */
export const videoBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('video'),
  title: z.string().trim().max(120).default(''),
  subtitle: z.string().trim().max(300).default(''),
  /** A YouTube URL or a bare video id; the client extracts the id. */
  url: z.string().trim().max(400).default(''),
});

/** A pull quote. Bigger than body text, and attributed. */
export const quoteBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('quote'),
  quote: z.string().trim().max(600).default(''),
  attribution: z.string().trim().max(120).default(''),
});

/** Questions worth answering before somebody has to ask them. */
export const faqBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('faq'),
  title: z.string().trim().max(120).default(''),
  items: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(160),
        answer: z.string().trim().max(1200).default(''),
      }),
    )
    .max(20)
    .default([]),
});

export const textBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('text'),
  title: z.string().trim().max(120).default(''),
  /** Plain text; paragraphs split on blank lines. No HTML is ever rendered. */
  body: z.string().trim().max(4000).default(''),
  align: z.enum(['left', 'center']).default('left'),
  /** Larger body copy, for a short statement that carries a section on its own. */
  size: z.enum(['normal', 'large']).default('normal'),
});

/**
 * Space, and optionally a rule.
 *
 * The one block with no content at all. Two sections that both want to breathe
 * cannot be separated by editing either of them, and this is the difference
 * between a page with rhythm and a page that is one long scroll.
 */
export const dividerBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('divider'),
  line: z.boolean().default(true),
});

export const ctaBlockSchema = z.object({
  ...baseBlock,
  kind: z.literal('cta'),
  title: z.string().trim().max(120).default(''),
  body: z.string().trim().max(400).default(''),
  showDownload: z.boolean().default(true),
  showRegister: z.boolean().default(true),
  /** A panel, or the full width of the section with no card around it. */
  style: z.enum(['card', 'banner']).default('card'),
});

export const landingBlockSchema = z.discriminatedUnion('kind', [
  heroBlockSchema,
  featuresBlockSchema,
  stepsBlockSchema,
  statsBlockSchema,
  galleryBlockSchema,
  videoBlockSchema,
  quoteBlockSchema,
  faqBlockSchema,
  textBlockSchema,
  dividerBlockSchema,
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
  steps: 'How it works',
  stats: 'Stats',
  gallery: 'Screenshots',
  video: 'Video',
  quote: 'Quote',
  faq: 'FAQ',
  text: 'Text',
  divider: 'Spacer',
  cta: 'Call to action',
};

export const LANDING_BLOCK_HINTS: Record<LandingBlockKind, string> = {
  hero: 'The headline at the top, with the download and sign-up buttons.',
  features: 'A grid of short "what you get" cards.',
  steps: 'A numbered sequence — get an invite, install, play.',
  stats: 'A strip of numbers. Can pull the real game count from the server.',
  gallery: 'A row of screenshots or artwork.',
  video: 'One embedded YouTube video.',
  quote: 'A pull quote, larger than body text and attributed.',
  faq: 'Questions and answers, each one expandable.',
  text: 'A block of prose. Blank lines start new paragraphs.',
  divider: 'Space between two sections, with or without a rule.',
  cta: 'A closing prompt with the same buttons as the hero.',
};

/**
 * Pulls the video id out of whatever an operator pasted.
 *
 * Watch links, share links, embed links and a bare id are all things people
 * reasonably paste into a box labelled "YouTube URL". Returns null for
 * anything else, which is what keeps a non-YouTube URL from being framed
 * against the page's content security policy.
 */
export function youtubeId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  const match =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(
      trimmed,
    );
  return match?.[1] ?? null;
}

/**
 * What a server shows before anyone has edited anything.
 *
 * A composed page rather than a stack of defaults: alternating surfaces, a
 * hero that is allowed some height, and the two things a visitor to an
 * invite-only archive actually needs told — what it is, and how to get in.
 * Every part of it is editable, and `Reset` puts this back.
 */
export function defaultLandingBlocks(): LandingBlock[] {
  return [
    {
      id: 'hero',
      kind: 'hero',
      visible: true,
      padding: 'roomy',
      background: 'none',
      width: 'normal',
      eyebrow: 'Self-hosted, invite only',
      headline: '',
      subheadline: '',
      showDownload: true,
      showRegister: true,
      backgroundUrl: '',
      overlay: 60,
      align: 'left',
      height: 'tall',
    },
    {
      id: 'features',
      kind: 'features',
      visible: true,
      padding: 'normal',
      background: 'none',
      width: 'normal',
      title: 'Everything in one place',
      subtitle: '',
      columns: 3,
      style: 'card',
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
      padding: 'compact',
      background: 'none',
      width: 'normal',
      title: '',
      showGameCount: true,
      style: 'card',
      items: [],
    },
    {
      id: 'steps',
      kind: 'steps',
      visible: true,
      padding: 'normal',
      // A different surface from its neighbours, so the page reads as sections
      // rather than as one continuous scroll.
      background: 'muted',
      width: 'normal',
      title: 'Getting in',
      subtitle: '',
      items: [
        { title: 'Get an invite', body: 'Ask whoever runs this server for a code.' },
        {
          title: 'Install the client',
          body: 'The Windows app is where the library actually lives.',
        },
        { title: 'Sign in and play', body: 'Everything you install is yours to keep.' },
      ],
    },
    {
      id: 'cta',
      kind: 'cta',
      visible: true,
      padding: 'roomy',
      background: 'none',
      width: 'normal',
      title: 'Get the client',
      body: 'The Windows app is where the library actually lives.',
      showDownload: true,
      showRegister: true,
      style: 'card',
    },
  ];
}
