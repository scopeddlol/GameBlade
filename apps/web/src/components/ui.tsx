import clsx from 'clsx';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin', className)} aria-hidden />;
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center gap-3" role="status">
      <Spinner className="text-blade-400 h-8 w-8" />
      <p className="text-ink-300 text-sm">{label}…</p>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  action,
}: {
  title?: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="gb-card flex flex-col items-center gap-3 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
      <h2 className="text-lg font-semibold">{title}</h2>
      {message ? <p className="text-ink-300 max-w-md text-sm">{message}</p> : null}
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-ink-700 flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
      <h2 className="text-ink-100 text-lg font-semibold">{title}</h2>
      {message ? <p className="text-ink-300 max-w-md text-sm">{message}</p> : null}
      {action}
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
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-ink-700 text-ink-200',
        tone === 'info' && 'bg-blade-700/30 text-blade-400',
      )}
      // Status tints are scheme-dependent — a near-black fill is right on a
      // dark chrome and unreadable on a light one — so they come from tokens
      // the theme sets rather than from fixed palette steps.
      style={
        tone === 'success' || tone === 'warning' || tone === 'danger'
          ? {
              background: `var(--status-${tone}-bg)`,
              color: `var(--status-${tone}-fg)`,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="gb-note-danger" role="alert">
      {message}
    </p>
  );
}

/** A short confirmation. Pairs with FormError, and follows the theme. */
export function Notice({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="gb-note" role="status">
      {message}
    </p>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="gb-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-ink-400 mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}
