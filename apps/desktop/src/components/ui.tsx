import clsx from 'clsx';
import { AlertTriangle, CloudUpload, Loader2, Trophy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useArtwork } from '../hooks/useArtwork.js';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('spin', className)} size={18} aria-hidden />;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <Spinner />
      <p className="muted">{label}…</p>
    </div>
  );
}

/**
 * A page's shape while its data is on the way.
 *
 * The spinner it replaces sat in the middle of an empty screen, which reads as
 * "nothing is here" rather than "this is arriving" — and then everything
 * appeared at once and shoved the page around. Holding the layout costs
 * nothing and makes the same wait feel like a fraction of it.
 */
export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}

/** The same idea for a grid of covers. */
export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="skeleton-grid" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton-cover" />
      ))}
    </div>
  );
}

/** And for a list of rows — requests, friends, announcements. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-row" />
      ))}
    </div>
  );
}

export function Empty({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state empty">
      <h2>{title}</h2>
      {message ? <p className="muted">{message}</p> : null}
      {action}
    </div>
  );
}

export function ErrorNote({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      <AlertTriangle size={16} aria-hidden />
      {message}
    </p>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Artwork with a graceful hole in it. Missing covers are routine in an archive
 * of freeware, so an unmatched game shows its initials rather than a broken
 * image icon.
 */
export function Artwork({
  path,
  alt,
  className,
  fallbackText,
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
  fallbackText?: string;
}) {
  const url = useArtwork(path);
  // A URL that resolves and then fails to load is the offline case: the client
  // knows the cover's address, has never cached the bytes, and the server is
  // not there to supply them. Without this the grid fills with broken-image
  // icons, which is a worse answer than the initials it already draws for a
  // game that has no artwork at all.
  const [broken, setBroken] = useState(false);

  useEffect(() => setBroken(false), [url]);

  if (!url || broken) {
    return (
      <div className={clsx('artwork placeholder', className)} aria-label={alt} role="img">
        <span>{initials(fallbackText ?? alt)}</span>
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      className={clsx('artwork', className)}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({
  url,
  name,
  size = 32,
  accent,
  presence,
}: {
  url: string | null;
  name: string;
  size?: number;
  accent?: string;
  presence?: 'offline' | 'online' | 'away' | 'in-game';
}) {
  const resolved = useArtwork(url);

  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {resolved ? (
        <img src={resolved} alt="" className="avatar" style={{ width: size, height: size }} />
      ) : (
        <span
          className="avatar placeholder"
          style={{
            width: size,
            height: size,
            background: accent ?? 'var(--ink-700)',
            fontSize: Math.max(10, size * 0.4),
          }}
          aria-hidden
        >
          {initials(name)}
        </span>
      )}
      {presence && presence !== 'offline' ? (
        <span className={clsx('presence-dot', presence)} title={presence} />
      ) : null}
    </span>
  );
}

/**
 * Whether a game is set up for cloud saves and achievements.
 *
 * Both are things an operator configures per game, and until now the only way
 * to find out was to play one and see whether anything happened. A player
 * choosing what to install has a fair claim on knowing which of their games
 * will carry their saves between machines.
 *
 * Absence is stated rather than left blank: a missing badge reads as "the
 * page has not loaded" where a greyed one reads as "not set up here".
 */
export function GameCapabilities({
  hasSaveRule,
  achievementCount,
  unlockedCount = 0,
  compact = false,
}: {
  hasSaveRule: boolean;
  achievementCount: number;
  unlockedCount?: number;
  compact?: boolean;
}) {
  const hasAchievements = achievementCount > 0;

  return (
    <div className={clsx('capabilities', compact && 'compact')}>
      <span
        className={clsx('capability', hasSaveRule && 'on')}
        title={
          hasSaveRule
            ? 'Cloud saves are set up: your saves follow you between machines.'
            : 'No cloud-save rule, so saves for this game stay on this machine.'
        }
      >
        <CloudUpload size={compact ? 11 : 13} aria-hidden />
        {compact ? null : <span>Cloud saves</span>}
      </span>

      <span
        className={clsx('capability', hasAchievements && 'on')}
        title={
          hasAchievements
            ? `${achievementCount} achievements tracked${unlockedCount > 0 ? `, ${unlockedCount} unlocked` : ''}.`
            : 'No achievements set up for this game.'
        }
      >
        <Trophy size={compact ? 11 : 13} aria-hidden />
        {compact ? null : (
          <span>
            {hasAchievements
              ? `${unlockedCount > 0 ? `${unlockedCount}/${achievementCount}` : achievementCount} achievements`
              : 'No achievements'}
          </span>
        )}
      </span>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={clsx('badge', tone)}>{children}</span>;
}

/** A centered dialog, for anything that should not be a native browser confirm. */
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = true,
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={clsx('btn', danger ? 'btn-danger' : 'btn-primary')}
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? <Spinner className="h-4 w-4" /> : null}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}
