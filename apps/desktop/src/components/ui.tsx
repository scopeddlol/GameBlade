import clsx from 'clsx';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
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

  if (!url) {
    return (
      <div className={clsx('artwork placeholder', className)} aria-label={alt} role="img">
        <span>{initials(fallbackText ?? alt)}</span>
      </div>
    );
  }
  return <img src={url} alt={alt} className={clsx('artwork', className)} loading="lazy" />;
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
