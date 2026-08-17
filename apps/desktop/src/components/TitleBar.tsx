import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Minus, Square, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * Replaces the native Windows frame.
 *
 * The window is created with `decorations: false`, so this bar owns both the
 * drag region and the caption buttons. Anything interactive placed inside it
 * must opt out of dragging, otherwise a click gets swallowed by the drag
 * handler and the control never fires.
 */
export function TitleBar({ children }: { children?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined);

    // The window can also be maximised by dragging it to the top edge or by a
    // keyboard shortcut, so the icon follows the window rather than our clicks.
    void appWindow
      .onResized(() => {
        void appWindow
          .isMaximized()
          .then(setMaximized)
          .catch(() => undefined);
      })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => undefined);

    return () => unlisten?.();
  }, []);

  const appWindow = getCurrentWindow();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-content" data-tauri-drag-region>
        {children}
      </div>

      <div className="window-controls">
        <button
          type="button"
          className="window-button"
          onClick={() => void appWindow.minimize()}
          aria-label="Minimize"
        >
          <Minus size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="window-button"
          onClick={() => void appWindow.toggleMaximize()}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Square size={12} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
        </button>
        <button
          type="button"
          className="window-button close"
          onClick={() => void appWindow.close()}
          aria-label="Close"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
