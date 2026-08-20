import clsx from 'clsx';
import {
  Archive,
  BookOpen,
  CloudUpload,
  Download,
  Gamepad2,
  Gift,
  Globe,
  LifeBuoy,
  Link as LinkIcon,
  Megaphone,
  MessageCircle,
  Shield,
  Sparkles,
  Star,
  Swords,
  Trophy,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every icon an operator can attach to something.
 *
 * A fixed map rather than a dynamic lookup over lucide's whole export: the
 * stored value is operator input, and resolving it against every icon in the
 * library would both defeat tree-shaking and let a stray string pull in
 * anything. The desktop client keeps a matching map of its own — the two are
 * driven by the same constant lists in the shared package.
 */
export const ICONS: Record<string, LucideIcon> = {
  // Client buttons.
  link: LinkIcon,
  'message-circle': MessageCircle,
  'life-buoy': LifeBuoy,
  'book-open': BookOpen,
  gift: Gift,
  shield: Shield,
  star: Star,
  megaphone: Megaphone,
  wrench: Wrench,
  globe: Globe,
  // Landing-page feature cards.
  archive: Archive,
  'cloud-upload': CloudUpload,
  gamepad: Gamepad2,
  sparkles: Sparkles,
  swords: Swords,
  trophy: Trophy,
  users: Users,
  download: Download,
  zap: Zap,
};

/** Renders a stored icon name, or nothing when it is not one we ship. */
export function Icon({ name, className }: { name: string; className?: string }) {
  const Component = ICONS[name];
  if (!Component) return null;
  return <Component className={className ?? 'h-4 w-4'} aria-hidden />;
}

/**
 * Picks an icon by looking at it.
 *
 * A dropdown of names asks an operator to know what `life-buoy` looks like
 * before they can choose it; a grid of the actual marks does not. The names
 * stay as tooltips and accessible labels so the stored value is still
 * discoverable.
 */
export function IconPicker({
  value,
  options,
  onChange,
  label = 'Icon',
  id,
}: {
  value: string;
  options: readonly string[];
  onChange: (name: string) => void;
  label?: string;
  id?: string;
}) {
  return (
    <fieldset>
      <legend className="gb-label" id={id}>
        {label}
      </legend>
      <div
        className="border-ink-700 bg-ink-900 flex flex-wrap gap-1 rounded-lg border p-1.5"
        role="radiogroup"
        aria-labelledby={id}
      >
        {options.map((name) => {
          const active = value === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={name}
              title={name}
              className={clsx(
                'flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
                active
                  ? 'border-blade-500 bg-blade-500/15 text-blade-400'
                  : 'border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100',
              )}
              onClick={() => onChange(name)}
            >
              <Icon name={name} />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
