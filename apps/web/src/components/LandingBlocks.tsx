import type { LandingBlock, PublicServerInfo } from '@gameblade/shared';
import {
  Archive,
  CloudUpload,
  Download,
  Gamepad2,
  MonitorDown,
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

function ActionButtons({
  info,
  showDownload,
  showRegister,
  interactive,
  size = 'base',
}: {
  info: PublicServerInfo | undefined;
  showDownload: boolean;
  showRegister: boolean;
  interactive: boolean;
  size?: 'base' | 'lg';
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
  return <div className="mt-8 flex flex-wrap items-center gap-3">{buttons}</div>;
}

/**
 * Renders one landing-page block.
 *
 * Every block is a designed section rather than a positioned box, which is what
 * keeps an operator-authored page working at every width — including the phone
 * widths this same PR makes the rest of the site handle.
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
    case 'hero':
      return (
        <section className="relative overflow-hidden">
          {block.backgroundUrl ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-25"
              style={{ backgroundImage: `url(${JSON.stringify(block.backgroundUrl)})` }}
            />
          ) : (
            <div
              aria-hidden
              className="from-blade-500/12 pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent"
            />
          )}
          <div className="relative mx-auto max-w-6xl px-5 py-16 sm:py-24">
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              {block.headline || serverName}
            </h1>
            <p className="text-ink-300 mt-6 max-w-2xl text-base leading-relaxed text-pretty sm:text-lg">
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
            />
          </div>
        </section>
      );

    case 'features':
      return (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:py-16">
          {block.title ? (
            <h2 className="mb-8 text-2xl font-semibold tracking-tight sm:text-3xl">
              {block.title}
            </h2>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {block.items.map((item, index) => {
              const Icon = ICONS[item.icon] ?? Sparkles;
              return (
                <div key={`${item.title}-${index}`} className="gb-card p-5">
                  <Icon className="text-blade-400 h-6 w-6" aria-hidden />
                  <h3 className="mt-3 font-medium">{item.title}</h3>
                  {item.body ? (
                    <p className="text-ink-300 mt-1.5 text-sm leading-relaxed">{item.body}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
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
        <section className="mx-auto max-w-6xl px-5 py-12">
          {block.title ? (
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">{block.title}</h2>
          ) : null}
          <div className="gb-card grid gap-6 p-6 sm:grid-cols-2 lg:grid-cols-4">
            {entries.map((entry, index) => (
              <div key={`${entry.label}-${index}`}>
                <p className="text-3xl font-semibold tracking-tight tabular-nums">{entry.value}</p>
                <p className="text-ink-400 mt-1 text-sm">{entry.label}</p>
              </div>
            ))}
          </div>
        </section>
      );
    }

    case 'gallery':
      if (block.images.length === 0) return null;
      return (
        <section className="mx-auto max-w-6xl px-5 py-12">
          {block.title ? (
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">{block.title}</h2>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {block.images.map((image, index) => (
              <figure key={`${image.url}-${index}`} className="gb-card overflow-hidden">
                <img
                  src={image.url}
                  alt={image.caption || ''}
                  loading="lazy"
                  className="aspect-video w-full object-cover"
                />
                {image.caption ? (
                  <figcaption className="text-ink-400 px-3 py-2 text-xs">
                    {image.caption}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        </section>
      );

    case 'text':
      if (!block.body && !block.title) return null;
      return (
        <section
          className={`mx-auto max-w-3xl px-5 py-12 ${block.align === 'center' ? 'text-center' : ''}`}
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
                className="text-ink-300 mt-3 leading-relaxed whitespace-pre-line first:mt-0"
              >
                {paragraph}
              </p>
            ))}
        </section>
      );

    case 'cta':
      return (
        <section className="mx-auto max-w-6xl px-5 py-16">
          <div className="gb-card px-6 py-10 text-center sm:px-10">
            {block.title ? (
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{block.title}</h2>
            ) : null}
            {block.body ? (
              <p className="text-ink-300 mx-auto mt-3 max-w-xl leading-relaxed">{block.body}</p>
            ) : null}
            <div className="flex justify-center">
              <ActionButtons
                info={info}
                showDownload={block.showDownload}
                showRegister={block.showRegister}
                interactive={interactive}
              />
            </div>
          </div>
        </section>
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
