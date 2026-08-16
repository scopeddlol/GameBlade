import type { GameSummary } from '@gameblade/shared';
import { useEffect, useState } from 'react';
import { formatBytes, ipc } from '../lib/ipc.js';

export function GameTile({
  game,
  onDownload,
}: {
  game: GameSummary;
  onDownload: (game: GameSummary) => void;
}) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  // Artwork lives behind auth, so the URL has to be signed before <img> uses it.
  useEffect(() => {
    let cancelled = false;
    if (!game.art.cover) {
      setCoverUrl(null);
      return;
    }
    void ipc
      .imageUrl(game.art.cover)
      .then((url) => {
        if (!cancelled) setCoverUrl(url);
      })
      .catch(() => {
        if (!cancelled) setCoverUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [game.art.cover]);

  return (
    <div className="tile" onDoubleClick={() => onDownload(game)}>
      <div className="tile-art">
        {coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" />
        ) : (
          <div className="tile-fallback">{game.title}</div>
        )}
        <span className="tile-size">{formatBytes(game.sizeBytes)}</span>
      </div>

      <div className="tile-title" title={game.title}>
        {game.title}
      </div>
      <div className="tile-sub">
        {game.releaseDate ? new Date(game.releaseDate).getFullYear() : 'Unknown year'}
      </div>

      <button
        type="button"
        className="btn btn-ghost"
        style={{ width: '100%', marginTop: 6 }}
        onClick={() => onDownload(game)}
      >
        Download
      </button>
    </div>
  );
}
