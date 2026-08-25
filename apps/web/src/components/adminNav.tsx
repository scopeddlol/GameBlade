import type { QueryKey } from '@tanstack/react-query';
import {
  ChartLine,
  Gamepad2,
  LayoutDashboard,
  Palette,
  Sliders,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The admin panel's navigation, as one description both levels read from.
 *
 * There were fifteen top-level sections, which is more than anyone holds in
 * their head and more than fits down the side of a laptop without scrolling.
 * They are the same fifteen screens grouped into six by what an operator is
 * actually doing — minding the archive, minding the people in it, looking at
 * numbers, deciding how it looks, configuring it — with the rest as sub-tabs
 * inside each.
 *
 * Sidebar and sub-tab strip come from this same list so they can never
 * disagree about where a page lives, and the prefetch hints hang off it so
 * pointing at a section can start its request before the click lands.
 */

/** One request a page needs, so hovering its link can start it early. */
export interface Prefetch {
  key: QueryKey;
  path: string;
}

export interface AdminTab {
  /** Absolute, so `NavLink` needs no knowledge of where it is nested. */
  to: string;
  label: string;
  /** Matches only the exact path — for the tab that sits at the section root. */
  end?: boolean;
  /** What this page asks the server for the moment it mounts. */
  prefetch?: Prefetch[];
}

export interface AdminSection {
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line under the heading, saying what this section is for. */
  hint: string;
  end?: boolean;
  /** Empty for a section that is a single page. */
  tabs: AdminTab[];
}

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    to: '/admin',
    end: true,
    label: 'Overview',
    icon: LayoutDashboard,
    hint: 'What the server is doing right now.',
    tabs: [],
  },
  {
    to: '/admin/catalog',
    label: 'Catalog',
    icon: Gamepad2,
    hint: 'The games themselves — what is on the shelf, what it looks like and where it comes from.',
    tabs: [
      {
        to: '/admin/catalog',
        label: 'Games',
        end: true,
        prefetch: [{ key: ['admin', 'stats'], path: '/admin/stats' }],
      },
      {
        to: '/admin/catalog/achievements',
        label: 'Achievements',
        prefetch: [{ key: ['admin', 'stats'], path: '/admin/stats' }],
      },
      {
        to: '/admin/catalog/featured',
        label: 'Featured',
        prefetch: [{ key: ['admin', 'featured'], path: '/admin/featured' }],
      },
      {
        to: '/admin/catalog/save-paths',
        label: 'Save paths',
        prefetch: [{ key: ['admin', 'save-manifest'], path: '/admin/save-manifest' }],
      },
      {
        to: '/admin/catalog/libraries',
        label: 'Libraries',
        prefetch: [{ key: ['admin', 'libraries'], path: '/admin/libraries' }],
      },
    ],
  },
  {
    to: '/admin/players',
    label: 'Players',
    icon: Users,
    hint: 'Who is here, who is asking to be, and what they are asking for.',
    tabs: [
      {
        to: '/admin/players',
        label: 'Accounts',
        end: true,
        prefetch: [{ key: ['admin', 'users'], path: '/admin/users' }],
      },
      {
        to: '/admin/players/invites',
        label: 'Invites',
        prefetch: [{ key: ['admin', 'invites'], path: '/admin/invites' }],
      },
      { to: '/admin/players/requests', label: 'Game requests' },
      { to: '/admin/players/bugs', label: 'Bug reports' },
    ],
  },
  {
    to: '/admin/insights',
    label: 'Insights',
    icon: ChartLine,
    hint: 'Traffic, storage and whether anything needs attention.',
    tabs: [
      { to: '/admin/insights', label: 'Analytics', end: true },
      {
        to: '/admin/insights/health',
        label: 'Health',
        prefetch: [{ key: ['admin', 'health'], path: '/admin/health' }],
      },
    ],
  },
  {
    to: '/admin/appearance',
    label: 'Appearance',
    icon: Palette,
    hint: 'What everyone else sees — the colours, the landing page and the client itself.',
    tabs: [
      {
        to: '/admin/appearance',
        label: 'Theme',
        end: true,
        prefetch: [{ key: ['admin', 'theme'], path: '/admin/theme' }],
      },
      {
        to: '/admin/appearance/landing',
        label: 'Landing page',
        prefetch: [{ key: ['admin', 'landing'], path: '/admin/landing' }],
      },
      {
        to: '/admin/appearance/client',
        label: 'Desktop client',
        prefetch: [{ key: ['admin', 'client-buttons'], path: '/admin/client-buttons' }],
      },
    ],
  },
  {
    to: '/admin/settings',
    label: 'Settings',
    icon: Sliders,
    hint: 'Server configuration, credentials and keys.',
    tabs: [
      {
        to: '/admin/settings',
        label: 'Server',
        end: true,
        prefetch: [{ key: ['admin', 'settings'], path: '/admin/settings' }],
      },
      {
        to: '/admin/settings/discord',
        label: 'Discord',
        prefetch: [{ key: ['admin', 'discord'], path: '/admin/discord' }],
      },
      {
        to: '/admin/settings/api',
        label: 'API keys',
        prefetch: [{ key: ['admin', 'api-keys'], path: '/admin/api-keys' }],
      },
    ],
  },
];

/**
 * Where each old URL now lives.
 *
 * Kept rather than dropped because operators bookmark these, and a dead
 * bookmark that lands on the landing page reads as "the feature is gone"
 * rather than "it moved".
 */
export const ADMIN_REDIRECTS: Record<string, string> = {
  featured: '/admin/catalog/featured',
  'save-paths': '/admin/catalog/save-paths',
  libraries: '/admin/catalog/libraries',
  users: '/admin/players',
  invites: '/admin/players/invites',
  requests: '/admin/players/requests',
  bugs: '/admin/players/bugs',
  analytics: '/admin/insights',
  health: '/admin/insights/health',
  client: '/admin/appearance/client',
  api: '/admin/settings/api',
};

/** The section a path belongs to, for the heading and the sub-tab strip. */
export function sectionFor(pathname: string): AdminSection | undefined {
  // Longest prefix wins, so /admin/catalog/featured does not match /admin.
  return [...ADMIN_SECTIONS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((section) => pathname === section.to || pathname.startsWith(`${section.to}/`));
}
