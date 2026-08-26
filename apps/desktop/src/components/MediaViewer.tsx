import clsx from 'clsx';
import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArtwork } from '../hooks/useArtwork.js';
import { ipc } from '../lib/ipc.js';

/**
 * One thing the viewer can show.
 *
 * `path` is a server-relative media path for the first two kinds — an `<img>`
 * or `<video>` cannot send the device token, so it is resolved through the Rust
 * side, where the address and the token live. `youtube` carries a bare video id
 * instead: a trailer is hosted by YouTube and there is nothing of ours to
 * resolve.
 */
export interface MediaItem {
  kind: 'image' | 'video' | 'youtube';
  /** A server media path, or a YouTube video id. */
  path: string;
  label: string;
  /** Poster frame, where one exists. */
  thumbnailPath?: string | null;
  /**
   * A URL that is already loadable, used instead of resolving `path`.
   *
   * The case this exists for is a decrypted message attachment: it is served
   * from this machine's own disk and has no server-relative path to resolve.
   */
  resolvedUrl?: string;
}

/**
 * Full-screen viewing for anything the app shows: screenshots, clips, trailers.
 *
 * It replaces a 440-pixel-wide dialog. Screenshots opened into the same modal
 * shell used for confirmation prompts, which meant a 1920×1080 capture was
 * rendered about a fifth of its size, in the middle of a dark page, with two
 * text buttons underneath for Previous and Next. The whole point of opening a
 * screenshot is to look at it.
 *
 * So: the viewport, arrow keys, a filmstrip, and real controls for each kind
 * of thing rather than the same box around all of them.
 */
export function MediaViewer({
  items,
  startIndex = 0,
  onClose,
}: {
  items: MediaItem[];
  startIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  // Fit-to-window by default. A screenshot is usually larger than the window,
  // and opening at full size into a corner of the image is disorienting.
  const [actualSize, setActualSize] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const count = items.length;
  const item = items[index];

  const go = useCallback(
    (delta: number) => {
      setActualSize(false);
      setIndex((current) => (current + delta + count) % count);
    },
    [count],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (count < 2) return;
      // Left and right only: up and down belong to a video's own volume, and
      // stealing them would make the player behave unlike every other one.
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      }
    };

    document.addEventListener('keydown', onKey);
    // Focused so the keys work without the viewer having to be clicked first.
    surfaceRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [count, go, onClose]);

  if (!item) return null;

  return (
    <div
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={item.label}
      onClick={onClose}
      ref={surfaceRef}
      tabIndex={-1}
    >
      <header className="media-viewer-bar" onClick={(event) => event.stopPropagation()}>
        <span className="media-viewer-title">{item.label}</span>
        {count > 1 ? (
          <span className="muted small">
            {index + 1} of {count}
          </span>
        ) : null}

        <span className="spacer" />

        {item.kind === 'image' ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={actualSize ? 'Fit to window' : 'Show at full size'}
            title={actualSize ? 'Fit to window' : 'Show at full size'}
            onClick={() => setActualSize((current) => !current)}
          >
            {actualSize ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
          </button>
        ) : null}

        {item.kind === 'youtube' ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Open on YouTube"
            title="Open on YouTube"
            onClick={() => void ipc.openExternal(`https://www.youtube.com/watch?v=${item.path}`)}
          >
            <ExternalLink size={16} aria-hidden />
          </button>
        ) : null}

        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className="media-viewer-stage" onClick={(event) => event.stopPropagation()}>
        {count > 1 ? (
          <button
            type="button"
            className="media-viewer-nav prev"
            aria-label="Previous"
            onClick={() => go(-1)}
          >
            <ChevronLeft size={28} aria-hidden />
          </button>
        ) : null}

        {/* Keyed on the item so switching to a new one tears the old element
            down: without it a <video> keeps playing the previous clip's audio
            while showing the next one's first frame. */}
        <MediaSurface key={`${item.kind}-${item.path}`} item={item} actualSize={actualSize} />

        {count > 1 ? (
          <button
            type="button"
            className="media-viewer-nav next"
            aria-label="Next"
            onClick={() => go(1)}
          >
            <ChevronRight size={28} aria-hidden />
          </button>
        ) : null}
      </div>

      {count > 1 ? (
        <footer className="media-viewer-strip" onClick={(event) => event.stopPropagation()}>
          {items.map((entry, position) => (
            <button
              key={`${entry.kind}-${entry.path}`}
              type="button"
              className={clsx('media-viewer-thumb', position === index && 'active')}
              aria-label={entry.label}
              aria-current={position === index}
              onClick={() => {
                setActualSize(false);
                setIndex(position);
              }}
            >
              <Thumbnail item={entry} />
            </button>
          ))}
        </footer>
      ) : null}
    </div>
  );
}

/** The thing itself, with whichever controls its kind actually has. */
function MediaSurface({ item, actualSize }: { item: MediaItem; actualSize: boolean }) {
  const looked = useArtwork(item.kind === 'youtube' || item.resolvedUrl ? null : item.path);
  const resolved = item.resolvedUrl ?? looked;

  if (item.kind === 'youtube') {
    return (
      <iframe
        className="media-viewer-frame"
        // The privacy-preserving host, and no related videos from other
        // channels at the end — a trailer should not finish by advertising
        // somebody else's.
        src={`https://www.youtube-nocookie.com/embed/${item.path}?rel=0&modestbranding=1`}
        title={item.label}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    );
  }

  if (!resolved) {
    return (
      <div className="media-viewer-pending" role="status" aria-label="Loading">
        <span className="skeleton" />
      </div>
    );
  }

  if (item.kind === 'video') {
    return (
      // The browser's own controls: scrubbing, volume, playback rate,
      // picture-in-picture and fullscreen, all of which people already know
      // how to use and none of which is worth reimplementing badly.
      <video
        className="media-viewer-video"
        src={resolved}
        controls
        autoPlay
        preload="metadata"
        controlsList="nodownload"
      />
    );
  }

  return (
    <img
      className={clsx('media-viewer-image', actualSize && 'actual')}
      src={resolved}
      alt={item.label}
    />
  );
}

/** A filmstrip entry — the poster frame where there is one, the image itself otherwise. */
function Thumbnail({ item }: { item: MediaItem }) {
  const path =
    item.kind === 'youtube' || item.resolvedUrl ? null : (item.thumbnailPath ?? item.path);
  const looked = useArtwork(path);
  const resolved = item.resolvedUrl ?? looked;

  if (item.kind === 'youtube') {
    return <img src={`https://img.youtube.com/vi/${item.path}/mqdefault.jpg`} alt="" />;
  }
  if (!resolved) return <span className="skeleton" aria-hidden />;
  // A clip's filmstrip entry is its own first frame; asking a <video> for one
  // is cheaper than storing a separate poster we would also have to encrypt.
  if (item.kind === 'video') {
    return <video src={resolved} muted preload="metadata" />;
  }
  return <img src={resolved} alt="" loading="lazy" />;
}
