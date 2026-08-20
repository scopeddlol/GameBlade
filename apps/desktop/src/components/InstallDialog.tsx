import type { GameSummary } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/format.js';
import { errorMessage, ipc, type StorageLocation } from '../lib/ipc.js';
import { Badge, ErrorNote, Modal, ProgressBar } from './ui.js';

/** Under this much headroom a drive is called out rather than silently offered. */
const LOW_SPACE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Asks where a game should go before the download starts.
 *
 * Every install used to land in whichever folder was set as the default, which
 * is the wrong guess as soon as a machine has more than one drive and only
 * discoverable after the fact. The dialog is shown from every install button
 * so the answer is always the user's, and it shows free space because "which
 * drive" is really the question "which drive has room".
 */
export function InstallDialog({
  game,
  onClose,
  onStarted,
}: {
  game: Pick<GameSummary, 'id' | 'title' | 'sizeBytes'>;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const locationsQuery = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () => ipc.listStorageLocations(),
  });

  const install = useMutation({
    mutationFn: (destination?: string) => ipc.startDownload(game.id, destination),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
      onStarted?.();
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const locations = locationsQuery.data ?? [];

  return (
    <Modal title={`Install ${game.title}`} onClose={onClose}>
      <p className="muted small install-size">
        <HardDrive size={14} aria-hidden />
        {formatBytes(game.sizeBytes)} needed
      </p>

      <ErrorNote message={error} />

      {locationsQuery.isLoading ? (
        <p className="muted">Looking at your drives…</p>
      ) : locations.length === 0 ? (
        <p className="muted">
          No install location is configured. Add one under Settings → Downloads, then try again.
        </p>
      ) : (
        <div className="storage-locations">
          {locations.map((location) => (
            <LocationChoice
              key={location.path}
              location={location}
              needed={game.sizeBytes}
              pending={install.isPending}
              onChoose={() => install.mutate(location.path)}
            />
          ))}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function LocationChoice({
  location,
  needed,
  pending,
  onChoose,
}: {
  location: StorageLocation;
  needed: number;
  pending: boolean;
  onChoose: () => void;
}) {
  const usedPercent =
    location.total_bytes > 0
      ? ((location.total_bytes - location.available_bytes) / location.total_bytes) * 100
      : 0;

  // Told plainly rather than left for the user to work out from two numbers,
  // and refused outright when it cannot fit — a download that dies at 90% for
  // want of disk is the worst way to find this out.
  const fits = location.available_bytes >= needed;
  const tight = fits && location.available_bytes - needed < LOW_SPACE_BYTES;

  return (
    <button
      type="button"
      className="storage-location storage-location-pick"
      onClick={onChoose}
      disabled={pending || !fits}
      title={fits ? location.path : 'Not enough free space for this game'}
    >
      <div className="storage-location-head">
        <span className="path">{location.path}</span>
        {location.is_default ? <Badge tone="info">Default</Badge> : null}
        {!fits ? <Badge tone="danger">Not enough room</Badge> : null}
        {tight ? <Badge tone="warning">Tight fit</Badge> : null}
      </div>
      <ProgressBar value={usedPercent} />
      <span className="muted small">
        {formatBytes(location.available_bytes)} free of {formatBytes(location.total_bytes)}
        {fits ? ` · ${formatBytes(location.available_bytes - needed)} left after` : ''}
      </span>
    </button>
  );
}

/**
 * Holds whichever game is waiting on a destination.
 *
 * The dialog is opened from four places — the detail drawer, both library
 * layouts, the store and the right-click menu — and each of them only needs
 * somewhere to put the game it was clicked on.
 */
export function useInstallDialog() {
  const [game, setGame] = useState<Pick<GameSummary, 'id' | 'title' | 'sizeBytes'> | null>(null);
  return {
    game,
    request: setGame,
    close: () => setGame(null),
  };
}
