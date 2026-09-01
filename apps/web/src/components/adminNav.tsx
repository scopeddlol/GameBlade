import type { ServerRole } from '@gameblade/shared';
import type { QueryKey } from '@tanstack/react-query';
import {
  ChartLine,
  Gamepad2,
  LayoutDashboard,
  Palette,
  Server,
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
 *
 * Some of it depends on what the deployment is. A coordinator holds no game
 * files, so a folder to add and a disk to scan are not things it has — see
 * `adminSections`.
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
  /** Roles this tab applies to. Absent means every role. */
  roles?: ServerRole[];
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
  /**
   * Roles this entry applies to. Absent means every role.
   *
   * On the tabs as well as the sections, because the difference between a
   * coordinator and a standalone server is one tab in one section rather than
   * a whole different panel.
   */
  roles?: ServerRole[];
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
        to: '/admin/catalog/matches',
        label: 'Metadata matches',
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
        to: '/admin/catalog/launch-rules',
        label: 'Launch rules',
        prefetch: [
          {
            key: ['admin', 'launch-rules', 'missing', '', 0],
            path: '/admin/launch-rules?status=missing&offset=0&limit=50',
          },
        ],
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
        // A coordinator has no disk. Its libraries are the labels its nodes'
        // catalogs are filed under, created when a node enrols, and the page
        // that manages them is Nodes — where the machine that actually holds
        // the files is.
        roles: ['standalone'],
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
    to: '/admin/nodes',
    label: 'Nodes',
    icon: Server,
    hint: 'The machines holding the games, what they are serving, and to whom.',
    // A standalone server is one machine with the files on it, so there is no
    // fleet to watch. The section appears the moment there is something to put
    // in it, which on a coordinator is from the first enrolment.
    roles: ['coordinator', 'standalone'],
    tabs: [
      {
        to: '/admin/nodes',
        label: 'Fleet',
        end: true,
        prefetch: [{ key: ['admin', 'mesh'], path: '/mesh/nodes' }],
      },
      {
        to: '/admin/nodes/analytics',
        label: 'Analytics',
        prefetch: [{ key: ['admin', 'mesh', 'analytics'], path: '/mesh/analytics?days=14' }],
      },
      {
        to: '/admin/nodes/enrolment',
        label: 'Enrolment',
        prefetch: [{ key: ['admin', 'mesh'], path: '/mesh/nodes' }],
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
  'settings/nodes': '/admin/nodes',
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

/**
 * The sections and tabs this deployment actually has.
 *
 * Filtered rather than conditionally rendered in each place, so the sidebar,
 * the sub-tab strip and the router cannot end up disagreeing about whether a
 * page exists — which is how you get a tab that navigates to a blank screen.
 *
 * The role is not a permission. The server refuses the routes behind a hidden
 * tab on its own; this is about not offering somebody an action that cannot
 * work on the machine they are looking at.
 */
export function adminSections(role: ServerRole): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => !section.roles || section.roles.includes(role)).map(
    (section) => ({
      ...section,
      tabs: section.tabs.filter((tab) => !tab.roles || tab.roles.includes(role)),
    }),
  );
}

/** The section a path belongs to, for the heading and the sub-tab strip. */
export function sectionFor(
  pathname: string,
  role: ServerRole = 'standalone',
): AdminSection | undefined {
  // Longest prefix wins, so /admin/catalog/featured does not match /admin.
  return [...adminSections(role)]
    .sort((a, b) => b.to.length - a.to.length)
    .find((section) => pathname === section.to || pathname.startsWith(`${section.to}/`));
}
