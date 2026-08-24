import { youtubeId, type LandingBlock, type PublicServerInfo } from '@gameblade/shared';
import clsx from 'clsx';
import {
  Archive,
  CloudUpload,
  Download,
  Gamepad2,
  MonitorDown,
  Quote,
  Shield,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '../lib/format.js';

/**
 * Icons a feature card can wear.
 *
 * A fixed map, not a dynamic lookup over lucide's whole export: the stored
 * value is operator input, and resolving it against every icon in the library
 * would both defeat tree-shaking and let a stray string pull in anything.
 */
const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  'cloud-upload': CloudUpload,
  gamepad: Gamepad2,
  sparkles: Sparkles,
  swords: Swords,
  trophy: Trophy,
  users: Users,
  shield: Shield,
  download: Download,
  zap: Zap,
};

export interface LandingContext {
  info: PublicServerInfo | undefined;
  /** False inside the editor preview, where navigation would be wrong. */
  interactive?: boolean;
}

/* ------------------------------------------------------------- decoration */

const PADDING = {
  compact: 'py-8',
  normal: 'py-12 sm:py-16',
  roomy: 'py-20 sm:py-28',
} as const;

const WIDTH = {
  narrow: 'max-w-3xl',
  normal: 'max-w-6xl',
  wide: 'max-w-7xl',
} as const;

const COLUMNS = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
} as const;

const RATIO = {
  video: 'aspect-video',
  square: 'aspect-square',
  portrait: 'aspect-2/3',
  wide: 'aspect-21/9',
} as const;

/**
 * The surface a section sits on.
 *
 * Every option is drawn from theme tokens rather than fixed palette steps, so
 * an operator on a light theme gets a light muted band rather than a dark
 * stripe through a pale page.
 */
function backgroundClass(background: LandingBlock['background']): string {
  if (background === 'muted') return 'bg-ink-850/60 border-ink-800 border-y';
  if (background === 'accent') return 'from-blade-500/10 bg-gradient-to-b to-transparent';
  return '';
}

/**
 * The wrapper every section shares.
 *
 * Padding, surface and content width live here rather than being repeated per
 * block, which is what lets a new block kind pick them up for free — and what
 * stops two blocks disagreeing about what "roomy" means.
 */
function Section({
  block,
  className,
  children,
}: {
  block: LandingBlock;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx(backgroundClass(block.background), PADDING[block.padding])}>
      <div className={clsx('mx-auto px-5', WIDTH[block.width], className)}>{children}</div>
    </section>
  );
}

/** A section's heading and optional standfirst, laid out the same way each time. */
function Heading({
  title,
  subtitle,
  center,
}: {
  title: string;
  subtitle?: string;
  center?: boolean;
}) {
  if (!title && !subtitle) return null;
  return (
    <div className={clsx('mb-8', center && 'text-center')}>
      {title ? (
        <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h2>
      ) : null}
      {subtitle ? (
        <p
          className={clsx(
            'text-ink-300 mt-3 max-w-2xl leading-relaxed text-pretty',
            center && 'mx-auto',
          )}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function ActionButtons({
  info,
  showDownload,
  showRegister,
  interactive,
  size = 'base',
  center,
}: {
  info: PublicServerInfo | undefined;
  showDownload: boolean;
  showRegister: boolean;
  interactive: boolean;
  size?: 'base' | 'lg';
  center?: boolean;
}) {
  const padding = size === 'lg' ? 'px-5 py-2.5 text-base' : 'px-5 py-2.5';
  const buttons: ReactNode[] = [];

  if (showDownload && info?.downloadUrl) {
    const label = [
      info.clientVersion,
      info.downloadSizeBytes && formatBytes(info.downloadSizeBytes),
    ]
      .filter(Boolean)
      .join(' · ');
    buttons.push(
      <a
        key="download"
        href={interactive ? info.downloadUrl : undefined}
        className={`gb-btn-primary ${padding}`}
        onClick={interactive ? undefined : (event) => event.preventDefault()}
      >
        <MonitorDown className="h-5 w-5" aria-hidden />
        Download for Windows
        {label ? <span className="text-blade-400/90 text-sm font-normal">{label}</span> : null}
      </a>,
    );
  }

  if (showRegister && info?.allowSelfRegistration) {
    buttons.push(
      interactive ? (
        <Link key="register" to="/register" className={`gb-btn-ghost ${padding}`}>
          Create an account
        </Link>
      ) : (
        <span key="register" className={`gb-btn-ghost ${padding}`}>
          Create an account
        </span>
      ),
    );
  }

  if (buttons.length === 0 && showDownload) {
    buttons.push(
      <span
        key="none"
        className="border-ink-700 text-ink-400 rounded-lg border border-dashed px-5 py-2.5 text-sm"
      >
        The Windows client download has not been published yet.
      </span>,
    );
  }

  if (buttons.length === 0) return null;
  return (
    <div className={clsx('mt-8 flex flex-wrap items-center gap-3', center && 'justify-center')}>
      {buttons}
    </div>
  );
}

/**
 * Renders one landing-page block.
 *
 * Every block is a designed section rather than a positioned box, which is what
 * keeps an operator-authored page working at every width. What is adjustable is
 * the section's rhythm — its surface, its height, how many across it runs —
 * rather than where anything sits.
 */
export function LandingBlockView({
  block,
  context,
}: {
  block: LandingBlock;
  context: LandingContext;
}) {
  const { info, interactive = true } = context;
  const serverName = info?.serverName ?? 'GameBlade';

  switch (block.kind) {
    case 'hero': {
      const heights = {
        compact: 'py-14',
        normal: 'py-16 sm:py-24',
        tall: 'py-24 sm:py-36',
        full: 'py-28 sm:min-h-[78vh] sm:py-40',
      } as const;
      const centered = block.align === 'center';

      return (
        <section className={clsx('relative overflow-hidden', backgroundClass(block.background))}>
          {block.backgroundUrl ? (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${JSON.stringify(block.backgroundUrl)})` }}
              />
              {/* A scrim rather than a flat opacity on the image: the text has
                  to stay readable over a photograph nobody chose for contrast,
                  and how dark one is varies wildly. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `linear-gradient(to top, var(--color-ink-900) 0%, color-mix(in srgb, var(--color-ink-900) ${block.overlay}%, transparent) 100%)`,
                }}
              />
            </>
          ) : (
            <div
              aria-hidden
              className="from-blade-500/12 pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent"
            />
          )}

          <div
            className={clsx(
              'relative mx-auto flex flex-col justify-center px-5',
              WIDTH[block.width],
              heights[block.height],
              centered && 'items-center text-center',
            )}
          >
            {block.eyebrow ? (
              <p className="text-blade-400 mb-3 text-sm font-medium tracking-wide uppercase">
                {block.eyebrow}
              </p>
            ) : null}
            <h1
              className={clsx(
                'text-4xl font-semibold tracking-tight text-balance sm:text-5xl',
                centered ? 'max-w-4xl' : 'max-w-3xl',
              )}
            >
              {block.headline || serverName}
            </h1>
            <p
              className={clsx(
                'text-ink-300 mt-6 max-w-2xl text-base leading-relaxed text-pretty sm:text-lg',
              )}
            >
              {block.subheadline ||
                info?.tagline ||
                'A private home for free-to-play and DRM-free games worth keeping.'}
            </p>
            <ActionButtons
              info={info}
              showDownload={block.showDownload}
              showRegister={block.showRegister}
              interactive={interactive}
              size="lg"
              center={centered}
            />
          </div>
        </section>
      );
    }

    case 'features':
      return (
        <Section block={block}>
          <Heading title={block.title} subtitle={block.subtitle} />
          <div className={clsx('grid gap-4', COLUMNS[block.columns])}>
            {block.items.map((item, index) => {
              const Icon = ICONS[item.icon] ?? Sparkles;
              return (
                <div
                  key={`${item.title}-${index}`}
                  className={block.style === 'card' ? 'gb-card p-5' : ''}
                >
                  <Icon className="text-blade-400 h-6 w-6" aria-hidden />
                  <h3 className="mt-3 font-medium">{item.title}</h3>
                  {item.body ? (
                    <p className="text-ink-300 mt-1.5 text-sm leading-relaxed">{item.body}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Section>
      );

    case 'steps':
      if (block.items.length === 0) return null;
      return (
        <Section block={block}>
          <Heading title={block.title} subtitle={block.subtitle} />
          <ol className="grid gap-4 sm:grid-cols-3">
            {block.items.map((item, index) => (
              <li key={`${item.title}-${index}`} className="relative">
                {/* The number carries the ordering, which is the whole reason
                    this is not a feature grid. */}
                <span className="border-blade-500/40 text-blade-400 flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold tabular-nums">
                  {index + 1}
                </span>
                <h3 className="mt-3 font-medium">{item.title}</h3>
                {item.body ? (
                  <p className="text-ink-300 mt-1.5 text-sm leading-relaxed">{item.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      );

    case 'stats': {
      const entries = [
        ...(block.showGameCount && info
          ? [{ label: 'Games archived', value: info.gameCount.toLocaleString() }]
          : []),
        ...block.items,
      ];
      if (entries.length === 0) return null;
      return (
        <Section block={block}>
          <Heading title={block.title} />
          <div
            className={clsx(
              'grid gap-6 sm:grid-cols-2 lg:grid-cols-4',
              block.style === 'card' && 'gb-card p-6',
            )}
          >
            {entries.map((entry, index) => (
              <div key={`${entry.label}-${index}`}>
                <p className="text-3xl font-semibold tracking-tight tabular-nums">{entry.value}</p>
                <p className="text-ink-400 mt-1 text-sm">{entry.label}</p>
              </div>
            ))}
          </div>
        </Section>
      );
    }

    case 'gallery':
      if (block.images.length === 0) return null;
      return (
        <Section block={block}>
          <Heading title={block.title} />
          <div className={clsx('grid gap-3', COLUMNS[block.columns])}>
            {block.images.map((image, index) => (
              <figure key={`${image.url}-${index}`} className="gb-card overflow-hidden">
                <img
                  src={image.url}
                  alt={image.caption || ''}
                  loading="lazy"
                  className={clsx('w-full object-cover', RATIO[block.ratio])}
                />
                {image.caption ? (
                  <figcaption className="text-ink-400 px-3 py-2 text-xs">
                    {image.caption}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        </Section>
      );

    case 'video': {
      // Anything that is not a YouTube link renders as nothing rather than as
      // a frame the page's content security policy will block.
      const id = youtubeId(block.url);
      if (!id) return null;
      return (
        <Section block={block} className="max-w-4xl">
          <Heading title={block.title} subtitle={block.subtitle} center />
          <div className="gb-card aspect-video overflow-hidden">
            <iframe
              className="h-full w-full"
              src={`https://www.youtube.com/embed/${id}`}
              title={block.title || 'Video'}
              loading="lazy"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </Section>
      );
    }

    case 'quote':
      if (!block.quote) return null;
      return (
        <Section block={block} className="max-w-3xl text-center">
          <Quote className="text-blade-400/50 mx-auto h-8 w-8" aria-hidden />
          <blockquote className="mt-4 text-xl leading-relaxed text-pretty sm:text-2xl">
            {block.quote}
          </blockquote>
          {block.attribution ? (
            <p className="text-ink-400 mt-4 text-sm">— {block.attribution}</p>
          ) : null}
        </Section>
      );

    case 'faq':
      if (block.items.length === 0) return null;
      return (
        <Section block={block} className="max-w-3xl">
          <Heading title={block.title} />
          <div className="divide-ink-800 gb-card divide-y">
            {block.items.map((item, index) => (
              // Native disclosure rather than a scripted accordion: it is
              // keyboard-accessible, findable by the browser's own find, and
              // works before any JavaScript has run.
              <details key={`${item.question}-${index}`} className="group px-5 py-4">
                <summary className="flex cursor-pointer items-center gap-3 font-medium marker:content-['']">
                  <span className="flex-1">{item.question}</span>
                  <span
                    className="text-ink-400 transition-transform group-open:rotate-45"
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                {item.answer ? (
                  <p className="text-ink-300 mt-2.5 leading-relaxed whitespace-pre-line">
                    {item.answer}
                  </p>
                ) : null}
              </details>
            ))}
          </div>
        </Section>
      );

    case 'text':
      if (!block.body && !block.title) return null;
      return (
        <Section
          block={block}
          className={clsx('max-w-3xl', block.align === 'center' && 'text-center')}
        >
          {block.title ? (
            <h2 className="mb-4 text-2xl font-semibold tracking-tight">{block.title}</h2>
          ) : null}
          {/* Split on blank lines and rendered as text nodes — operator copy is
              never interpreted as HTML. */}
          {block.body
            .split(/\n\s*\n/)
            .filter(Boolean)
            .map((paragraph, index) => (
              <p
                key={index}
                className={clsx(
                  'text-ink-300 mt-3 leading-relaxed whitespace-pre-line first:mt-0',
                  block.size === 'large' && 'text-lg sm:text-xl',
                )}
              >
                {paragraph}
              </p>
            ))}
        </Section>
      );

    case 'divider':
      return (
        <div className={clsx('mx-auto px-5', WIDTH[block.width], PADDING[block.padding])}>
          {block.line ? <hr className="border-ink-800" /> : null}
        </div>
      );

    case 'cta':
      return (
        <Section block={block}>
          <div
            className={clsx(
              'text-center',
              block.style === 'card' ? 'gb-card px-6 py-10 sm:px-10' : '',
            )}
          >
            {block.title ? (
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{block.title}</h2>
            ) : null}
            {block.body ? (
              <p className="text-ink-300 mx-auto mt-3 max-w-xl leading-relaxed">{block.body}</p>
            ) : null}
            <ActionButtons
              info={info}
              showDownload={block.showDownload}
              showRegister={block.showRegister}
              interactive={interactive}
              center
            />
          </div>
        </Section>
      );

    default:
      return null;
  }
}

/** The whole page, skipping anything an operator has hidden. */
export function LandingBlocks({
  blocks,
  context,
}: {
  blocks: LandingBlock[];
  context: LandingContext;
}) {
  return (
    <>
      {blocks
        .filter((block) => block.visible)
        .map((block) => (
          <LandingBlockView key={block.id} block={block} context={context} />
        ))}
    </>
  );
}
