import { isUpdateAvailable, type PublicServerInfo } from '@gameblade/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, ipc } from '../lib/ipc.js';

/** Remembers a dismissal per version, so "later" is not "never". */
const DISMISSED_KEY = 'gameblade.update.dismissed';

/**
 * Tells the user when the operator has published a newer client.
 *
 * Notifies and asks rather than replacing anything on its own: the installer
 * already knows how to upgrade an install, and a client that silently swapped
 * itself out mid-download would be worse than one that is a version behind.
 *
 * Dismissal is remembered against the version it was shown for, so declining
 * 0.5.0 stays declined but 0.5.1 asks again.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem(DISMISSED_KEY),
  );
  const [error, setError] = useState<string | null>(null);

  const versionQuery = useQuery({
    queryKey: ['client-version'],
    queryFn: () => ipc.clientVersion(),
    staleTime: Infinity,
  });

  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => ipc.get<PublicServerInfo>('/public/info'),
    // The operator uploads a build whenever they like; an app left open
    // overnight should notice by morning.
    refetchInterval: 30 * 60_000,
    staleTime: 5 * 60_000,
  });

  const install = useMutation({
    mutationFn: () => ipc.runClientInstaller(),
    onError: (caught) => setError(errorMessage(caught)),
  });

  const running = versionQuery.data;
  const published = infoQuery.data?.clientVersion;

  // Nothing to offer unless the server actually has an installer to hand out;
  // a version bumped in settings with no upload behind it is not an update.
  const hasInstaller = Boolean(infoQuery.data?.downloadFileName);
  if (!hasInstaller || !isUpdateAvailable(running, published)) return null;
  if (published && dismissed === published) return null;

  return (
    <div className="update-banner" role="status">
      <Download size={16} aria-hidden />
      <span className="update-banner-text">
        <strong>Version {published} is available</strong>
        <span className="muted small">
          {error ?? `You are running ${running}. The installer will walk you through it.`}
        </span>
      </span>

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => install.mutate()}
        disabled={install.isPending}
      >
        {install.isPending ? <Loader2 size={14} className="spin" aria-hidden /> : null}
        {install.isPending ? 'Downloading…' : 'Update now'}
      </button>

      <button
        type="button"
        className="icon-btn"
        aria-label="Not now"
        onClick={() => {
          if (published) {
            localStorage.setItem(DISMISSED_KEY, published);
            setDismissed(published);
          }
        }}
      >
        <X size={15} aria-hidden />
      </button>
    </div>
  );
}
