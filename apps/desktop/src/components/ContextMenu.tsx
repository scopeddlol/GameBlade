import clsx from 'clsx';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

/** One row in a context menu. A separator carries nothing but its kind. */
export type MenuItem =
  | {
      kind?: 'item';
      label: string;
      icon?: ReactNode;
      /** Shown greyed out and unclickable, with the reason as a tooltip. */
      disabled?: boolean;
      disabledReason?: string;
      /** Renders in the danger colour — uninstall, delete, and friends. */
      danger?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' };

interface Position {
  x: number;
  y: number;
}

/**
 * A right-click menu anchored to the pointer.
 *
 * Rendered at a fixed position rather than inside the element that opened it:
 * a menu nested in a scrolling grid gets clipped by the first ancestor with
 * `overflow: hidden`, which in this app is every shelf and card.
 */
export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: Position;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Position>(position);

  // Flip the menu back inside the window when it would overflow. Measured after
  // layout because the size depends on the labels, which vary per game.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    const margin = 8;
    setPlaced({
      x: Math.max(margin, Math.min(position.x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(position.y, window.innerHeight - height - margin)),
    });
  }, [position]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, so a click anywhere closes the menu before that click is acted
    // on by whatever is underneath it.
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('resize', onClose);
    // A menu pinned to a pointer position is wrong the moment the page scrolls.
    window.addEventListener('scroll', onClose, true);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const visible = items.filter(
    (item, index) =>
      // Drop separators that would render at an edge or next to another one,
      // so a menu whose items are conditional never shows a stray rule.
      item.kind !== 'separator' ||
      (index > 0 && index < items.length - 1 && items[index - 1]?.kind !== 'separator'),
  );

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: placed.x, top: placed.y }}
      // The menu is opened by a right-click; right-clicking the menu itself
      // should not open the webview's own one on top of it.
      onContextMenu={(event) => event.preventDefault()}
    >
      {visible.map((item, index) =>
        item.kind === 'separator' ? (
          // eslint-disable-next-line react/no-array-index-key -- separators have no identity
          <div key={`sep-${index}`} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={clsx('context-menu-item', item.danger && 'danger')}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon ? (
              <span className="context-menu-icon" aria-hidden>
                {item.icon}
              </span>
            ) : (
              <span className="context-menu-icon" aria-hidden />
            )}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/**
 * Wires up one context menu for a whole screen.
 *
 * Returns an `open` handler to attach to `onContextMenu` and the element to
 * render. Keeping a single menu per screen rather than one per card means the
 * grid does not mount hundreds of listeners it will never use.
 */
export function useContextMenu<T>() {
  const [state, setState] = useState<{ position: Position; target: T } | null>(null);

  const open = useCallback((event: ReactMouseEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ position: { x: event.clientX, y: event.clientY }, target });
  }, []);

  const close = useCallback(() => setState(null), []);

  return { state, open, close };
}
