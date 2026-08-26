import { CloudOff, RefreshCw } from 'lucide-react';
import { useConnectivity } from '../hooks/useConnectivity.js';
import { formatRelative } from '../lib/format.js';

/**
 * Says the server is not there, and what still works while it is not.
 *
 * The point is the second half. "Offline" on its own reads as "this app is
 * broken now", which is what it used to be — and the whole change here is that
 * it is not: installed games launch, saves are written locally and go up when
 * the server comes back, and every page the client had already seen still
 * renders from what it last knew.
 */
export function OfflineBanner() {
  const { online, lastSeenAt, checking, recheck } = useConnectivity();
  if (online) return null;

  return (
    <div className="offline-banner" role="status">
      <CloudOff size={16} aria-hidden />
      <span>
        <strong>Offline</strong>
        <span className="muted small">
          Your installed games still work. Anything you change goes up when the server is back
          {lastSeenAt ? ` · last synced ${formatRelative(lastSeenAt.toISOString())}` : ''}.
        </span>
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => void recheck()}
        disabled={checking}
      >
        <RefreshCw size={14} aria-hidden className={checking ? 'spin' : undefined} />
        {checking ? 'Checking…' : 'Try again'}
      </button>
    </div>
  );
}
