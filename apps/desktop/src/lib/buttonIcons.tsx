import {
  BookOpen,
  Gift,
  Globe,
  LifeBuoy,
  Link as LinkIcon,
  Megaphone,
  MessageCircle,
  Shield,
  Star,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Icons an operator can attach to a custom button.
 *
 * A fixed map rather than a dynamic lookup on lucide's whole export: the
 * server stores whatever string it was given, and resolving that against every
 * icon in the library would let a stray value pull an arbitrary component into
 * the bundle — and would defeat tree-shaking for the ones nobody picked.
 */
const ICONS: Record<string, (size: number) => ReactNode> = {
  link: (size) => <LinkIcon size={size} />,
  'message-circle': (size) => <MessageCircle size={size} />,
  'life-buoy': (size) => <LifeBuoy size={size} />,
  'book-open': (size) => <BookOpen size={size} />,
  gift: (size) => <Gift size={size} />,
  shield: (size) => <Shield size={size} />,
  star: (size) => <Star size={size} />,
  megaphone: (size) => <Megaphone size={size} />,
  wrench: (size) => <Wrench size={size} />,
  globe: (size) => <Globe size={size} />,
};

/** Resolves a stored icon name, or null when it is not one we ship. */
export function buttonIcon(name: string, size = 18): ReactNode | null {
  return ICONS[name]?.(size) ?? null;
}
