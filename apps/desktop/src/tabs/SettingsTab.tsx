import {
  resolveTheme,
  THEME_PRESETS,
  THEMES,
  type DeviceInfo,
  type ProfileDetail,
  type PublicServerInfo,
  type SaveSlotInfo,
  type ThemePreset,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Bug,
  Check,
  CloudUpload,
  Download,
  EyeOff,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  LogOut,
  MonitorSmartphone,
  Palette,
  RotateCcw,
  Star,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Artwork,
  Avatar,
  Badge,
  ErrorNote,
  Loading,
  ProgressBar,
  SectionHeader,
} from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { themeStyle } from '../hooks/useTheme.js';
import { formatBytes, formatRelative } from '../lib/format.js';
import { errorMessage, ipc, type ClientSettings } from '../lib/ipc.js';
import { BUG_STATUS_LABELS, type BugReportInfo } from '@gameblade/shared';

export function SettingsTab() {
  const queryClient = useQueryClient();
  const { session, signOut } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<ClientSettings | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.getSettings(),
  });

  // Seed the editable copy once, so typing is not fighting a refetch.
  useEffect(() => {
    if (settingsQuery.data && !draft) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  const saveMutation = useMutation({
    mutationFn: (next: ClientSettings) => ipc.updateSettings(next),
    onSuccess: (saved) => {
      setDraft(saved);
      setNotice('Saved.');
      setError(null);
      // Written into the cache rather than only invalidated: the theme is
      // applied from this query, so waiting for a refetch would leave the
      // window on the old palette for a beat after the click.
      queryClient.setQueryData(['settings'], saved);
      void queryClient.invalidateQueries({ queryKey: ['storage-locations'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const update = (patch: Partial<ClientSettings>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    saveMutation.mutate(next);
  };

  if (settingsQuery.isLoading || !draft) return <Loading label="Loading settings" />;

  return (
    <div className="tab-content settings">
      <ErrorNote message={error} />
      {notice ? <p className="notice">{notice}</p> : null}

      <div className="settings-layout">
        <SettingsNav />

        <div className="settings-sections">
          <ProfileSection onError={setError} />

          <AppearanceSection draft={draft} onUpdate={update} />

          <section className="card" id="settings-storage">
            <SectionHeader
              title="Storage locations"
              subtitle="Where games install to. Installing a game offers a choice whenever more than one is set up."
            />
            <StorageLocationsField draft={draft} onUpdate={update} />
          </section>

          <section className="card" id="settings-downloads">
            <SectionHeader title="Downloads and installs" />

            <label className="field">
              <span>Simultaneous transfers</span>
              <input
                type="range"
                min={1}
                max={16}
                value={draft.downloadConcurrency}
                onChange={(e) => update({ downloadConcurrency: Number(e.target.value) })}
              />
              <span className="muted small">
                {draft.downloadConcurrency} at a time. More helps on a fast connection with many
                small files, and hurts on a slow one.
              </span>
            </label>

            <Toggle
              label="Verify downloads"
              hint="Check each file against the server's checksum after downloading."
              checked={draft.verifyDownloads}
              onChange={(verifyDownloads) => update({ verifyDownloads })}
            />
          </section>

          <section className="card" id="settings-saves">
            <SectionHeader title="Cloud saves" />

            <Toggle
              label="Sync saves automatically"
              hint="Pull before launching and push after quitting."
              checked={draft.syncSaves}
              onChange={(syncSaves) => update({ syncSaves })}
            />

            <Toggle
              label="Ask before overwriting"
              hint="When both this machine and the cloud have changed, choose which copy to keep instead of picking the newer one."
              checked={draft.promptOnSaveConflict}
              onChange={(promptOnSaveConflict) => update({ promptOnSaveConflict })}
            />

            <SaveUsage />
          </section>

          <section className="card" id="settings-privacy">
            <SectionHeader title="Privacy and presence" />

            <Toggle
              label="Share what I'm playing"
              hint="Turn this off to appear online without naming the game. Your profile's own privacy setting still applies on top."
              checked={draft.shareActivity}
              onChange={(shareActivity) => update({ shareActivity })}
            />

            <Toggle
              label="Minimize when a game starts"
              checked={draft.minimizeOnLaunch}
              onChange={(minimizeOnLaunch) => update({ minimizeOnLaunch })}
            />
          </section>

          <DevicesSection onError={setError} />

          <MyReportsSection />

          <section className="card" id="settings-account">
            <SectionHeader title="Account" />
            <p className="muted small">
              Signed in as <strong>{session?.username}</strong>
            </p>
            <button type="button" className="btn btn-danger" onClick={() => void signOut()}>
              <LogOut size={15} aria-hidden />
              Sign out
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

/** The sections, in the order they are laid out, for the jump list. */
const SETTINGS_SECTIONS = [
  { id: 'settings-profile', label: 'Profile', Icon: UserRound },
  { id: 'settings-appearance', label: 'Appearance', Icon: Palette },
  { id: 'settings-storage', label: 'Storage', Icon: HardDrive },
  { id: 'settings-downloads', label: 'Downloads', Icon: Download },
  { id: 'settings-saves', label: 'Cloud saves', Icon: CloudUpload },
  { id: 'settings-privacy', label: 'Privacy', Icon: EyeOff },
  { id: 'settings-devices', label: 'Devices', Icon: MonitorSmartphone },
  { id: 'settings-reports', label: 'Your reports', Icon: Bug },
  { id: 'settings-account', label: 'Account', Icon: LogOut },
] as const;

/** Noted once so the bottom clamp does not index past the end of the list. */
const LAST_SECTION: string = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]?.id ?? '';

/**
 * Jump list down the side of the settings page.
 *
 * The page is several screens tall whatever is done to it — there are simply
 * that many preferences — so the fix for "I cannot find the one I want" is a
 * way to go straight to it, not more scrolling. It tracks what is on screen so
 * the list also answers "where am I".
 */
function SettingsNav() {
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    // Whichever section's top has most recently passed the reading line near
    // the top of the page. Computed from scroll position rather than observed
    // intersections: an observer reports whatever the layout happened to be
    // when it first ran, which with artwork still loading is the wrong answer
    // and stays wrong until the next scroll.
    const LINE = 120;

    // The tab body scrolls, not the window. Looked up directly rather than
    // walked up from a section: the first one is still loading when this runs,
    // so starting from it would bind the listener to the window, which never
    // scrolls, and the highlight would never move again.
    const scroller: HTMLElement | Window = document.querySelector<HTMLElement>('.scroll') ?? window;

    const recompute = () => {
      // The last sections can never reach the reading line — there is not
      // enough page below them to scroll — so at the bottom the final one is
      // what the reader is looking at, whatever the geometry says.
      const box = scroller instanceof Window ? document.documentElement : scroller;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
        setActive(LAST_SECTION);
        return;
      }

      let current: string = SETTINGS_SECTIONS[0].id;
      for (const entry of SETTINGS_SECTIONS) {
        const node = document.getElementById(entry.id);
        if (node && node.getBoundingClientRect().top <= LINE) current = entry.id;
      }
      setActive(current);
    };

    recompute();
    scroller.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      scroller.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, []);

  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul>
        {SETTINGS_SECTIONS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={clsx('settings-nav-item', active === entry.id && 'active')}
              aria-current={active === entry.id ? 'true' : undefined}
              onClick={() =>
                document
                  .getElementById(entry.id)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <entry.Icon size={15} aria-hidden />
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * How this machine looks, independent of the server.
 *
 * The operator picks the archive's own theme and most players never touch
 * this; the point is that a player who does is not restyled the next time the
 * operator changes their mind. "Follow the server" stays the default and is
 * one click away again.
 */
function AppearanceSection({
  draft,
  onUpdate,
}: {
  draft: ClientSettings;
  onUpdate: (patch: Partial<ClientSettings>) => void;
}) {
  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => ipc.get<PublicServerInfo>('/public/info'),
    staleTime: 5 * 60_000,
  });

  const serverPreset = infoQuery.data?.theme?.preset;
  const following = !draft.themePreset;

  return (
    <section className="card settings-wide" id="settings-appearance">
      <SectionHeader
        title="Appearance"
        subtitle="Themes apply to this machine only. Nothing here changes what anyone else sees."
        action={
          following ? undefined : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onUpdate({ themePreset: null, themeAccent: null })}
            >
              <RotateCcw size={14} aria-hidden />
              Follow the server
            </button>
          )
        }
      />

      <div className="theme-grid">
        {THEME_PRESETS.map((preset) => {
          const theme = THEMES[preset];
          const active = following ? false : draft.themePreset === preset;
          return (
            <button
              key={preset}
              type="button"
              className={clsx('theme-swatch', active && 'active')}
              aria-pressed={active}
              title={theme.description}
              onClick={() => onUpdate({ themePreset: preset, themeAccent: null })}
              style={themeStyle(theme.tokens)}
            >
              {/* The swatch is painted with the theme's own tokens, so it shows
                  the surfaces and the accent together rather than a single hue
                  that says nothing about how the app will look. */}
              <span className="theme-preview" aria-hidden>
                <span className="theme-preview-bar" />
                <span className="theme-preview-body">
                  <span className="theme-preview-card" />
                  <span className="theme-preview-accent" />
                </span>
              </span>
              <span className="theme-swatch-label">
                {theme.label}
                {active ? <Check size={13} aria-hidden /> : null}
                {following && serverPreset === preset ? (
                  <span className="muted small">server</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {following ? (
        <p className="muted small">
          Currently following the server{serverPreset ? ` (${THEMES[serverPreset]?.label})` : ''}.
          Pick a theme above to override it here.
        </p>
      ) : (
        <label className="field accent-field">
          <span>Accent colour</span>
          <span className="accent-row">
            <input
              type="color"
              value={
                draft.themeAccent ?? resolveTheme(draft.themePreset as ThemePreset, null).accent500
              }
              aria-label="Accent colour"
              onChange={(event) => onUpdate({ themeAccent: event.target.value })}
            />
            {draft.themeAccent ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => onUpdate({ themeAccent: null })}
              >
                Use the theme&rsquo;s own
              </button>
            ) : null}
          </span>
          <span className="muted small">
            The lighter and darker steps are derived from this, so hover and focus states keep
            working.
          </span>
        </label>
      )}

      <div className="field">
        <span>Library layout</span>
        <div className="segmented" role="group" aria-label="Library layout">
          {(
            [
              { id: 'grid', label: 'Grid', Icon: LayoutGrid },
              { id: 'list', label: 'List', Icon: List },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={clsx('segment', draft.libraryView === option.id && 'active')}
              aria-pressed={draft.libraryView === option.id}
              onClick={() => onUpdate({ libraryView: option.id })}
            >
              <option.Icon size={14} aria-hidden />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        label="Use logo artwork for game titles"
        hint="Show a game's wordmark in place of its name where the archive has one."
        checked={draft.useLogoTitles}
        onChange={(useLogoTitles) => onUpdate({ useLogoTitles })}
      />
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="muted small">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Manages the list of places a game may be installed to. Disk usage is
 * fetched live rather than read off `draft`, since the settings object has
 * no notion of free space — only the paths themselves.
 */
function StorageLocationsField({
  draft,
  onUpdate,
}: {
  draft: ClientSettings;
  onUpdate: (patch: Partial<ClientSettings>) => void;
}) {
  const locationsQuery = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () => ipc.listStorageLocations(),
  });

  const usageByPath = new Map((locationsQuery.data ?? []).map((loc) => [loc.path, loc]));

  const addLocation = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Add a storage location',
    });
    if (typeof selected !== 'string' || selected === draft.installDir) return;
    if (draft.extraInstallDirs.includes(selected)) return;
    onUpdate({ extraInstallDirs: [...draft.extraInstallDirs, selected] });
  };

  const makeDefault = (path: string) => {
    onUpdate({
      installDir: path,
      extraInstallDirs: [draft.installDir, ...draft.extraInstallDirs.filter((dir) => dir !== path)],
    });
  };

  const remove = (path: string) => {
    onUpdate({ extraInstallDirs: draft.extraInstallDirs.filter((dir) => dir !== path) });
  };

  return (
    <div className="storage-locations">
      {[draft.installDir, ...draft.extraInstallDirs].map((path) => {
        const usage = usageByPath.get(path);
        const isDefault = path === draft.installDir;
        const usedPercent =
          usage && usage.total_bytes > 0
            ? ((usage.total_bytes - usage.available_bytes) / usage.total_bytes) * 100
            : 0;

        return (
          <div key={path} className="storage-location">
            <div className="storage-location-head">
              <span className="path">{path}</span>
              {isDefault ? <Badge tone="info">Default</Badge> : null}
            </div>
            <ProgressBar value={usedPercent} />
            <span className="muted small">
              {usage
                ? `${formatBytes(usage.available_bytes)} free of ${formatBytes(usage.total_bytes)}`
                : 'Checking…'}
            </span>
            {!isDefault ? (
              <div className="storage-location-actions">
                <button type="button" className="btn btn-ghost" onClick={() => makeDefault(path)}>
                  <Star size={13} aria-hidden />
                  Make default
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => remove(path)}>
                  <Trash2 size={13} aria-hidden />
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      <button type="button" className="btn btn-ghost" onClick={addLocation}>
        <FolderPlus size={15} aria-hidden />
        Add a location
      </button>
    </div>
  );
}

function ProfileSection({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => ipc.get<ProfileDetail>('/profile'),
  });

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [accent, setAccent] = useState('#7c5cff');
  const [country, setCountry] = useState('');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    const profile = profileQuery.data;
    if (!profile || seeded) return;
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? '');
    setAccent(profile.accentColor);
    setCountry(profile.country ?? '');
    setSeeded(true);
  }, [profileQuery.data, seeded]);

  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => ipc.patch('/profile', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile'] }),
    onError: (caught) => onError(errorMessage(caught)),
  });

  const changeAvatar = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      const media = await ipc.uploadMedia(selected, 'avatar');
      saveMutation.mutate({ avatarMediaId: media.id });
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };

  const changeBanner = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      const media = await ipc.uploadMedia(selected, 'banner');
      saveMutation.mutate({ bannerMediaId: media.id });
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };

  if (profileQuery.isLoading) return <Loading label="Loading profile" />;
  const profile = profileQuery.data;

  return (
    <section className="card settings-wide" id="settings-profile">
      <SectionHeader
        title="Profile"
        subtitle="Shown to friends and anyone who opens your profile from a post or the member list."
      />

      <div className="settings-banner">
        {profile?.bannerUrl ? <Artwork path={profile.bannerUrl} alt="" /> : null}
        <button type="button" className="btn btn-ghost" onClick={changeBanner}>
          {profile?.bannerUrl ? 'Change banner' : 'Add a banner'}
        </button>
      </div>

      <div className="profile-row">
        <Avatar
          url={profile?.avatarUrl ?? null}
          name={displayName || 'You'}
          accent={accent}
          size={64}
        />
        <button type="button" className="btn btn-ghost" onClick={changeAvatar}>
          Change avatar
        </button>
        {profile ? (
          <span className="muted small">
            {profile.gameCount} games · {profile.achievementCount} achievements ·{' '}
            {profile.friendCount} friends
          </span>
        ) : null}
      </div>

      <label className="field">
        <span>Display name</span>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onBlur={() => saveMutation.mutate({ displayName })}
        />
      </label>

      <label className="field">
        <span>Bio</span>
        <textarea
          className="input"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          onBlur={() => saveMutation.mutate({ bio: bio || null })}
        />
      </label>

      <label className="field">
        <span>Accent color</span>
        <input
          type="color"
          className="color-input"
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
          onBlur={() => saveMutation.mutate({ accentColor: accent })}
        />
      </label>

      <label className="field">
        <span>Country (optional)</span>
        <input
          className="input"
          value={country}
          maxLength={2}
          placeholder="US"
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
          onBlur={() => saveMutation.mutate({ country: country || null })}
        />
      </label>

      <label className="field">
        <span>Who can see your profile</span>
        <select
          className="select"
          value={profile?.visibility ?? 'friends'}
          onChange={(e) => saveMutation.mutate({ visibility: e.target.value })}
        >
          <option value="public">Everyone on this server</option>
          <option value="friends">Friends only</option>
          <option value="private">Nobody</option>
        </select>
      </label>

      <Toggle
        label="Show what I'm playing on my profile"
        hint="Turn this off to hide live activity from your profile page, even from friends."
        checked={profile?.showActivity ?? true}
        onChange={(showActivity) => saveMutation.mutate({ showActivity })}
      />
    </section>
  );
}

function SaveUsage() {
  const savesQuery = useQuery({
    queryKey: ['saves', 'usage'],
    queryFn: () =>
      ipc.get<{
        slots: SaveSlotInfo[];
        usage: { bytes: number; slots: number; versions: number };
        quotaBytes: number;
      }>('/saves'),
  });

  const data = savesQuery.data;
  if (!data) return null;

  return (
    <p className="muted small">
      {formatBytes(data.usage.bytes)} used across {data.usage.slots} save slots (
      {data.usage.versions} versions kept)
      {data.quotaBytes > 0 ? ` of ${formatBytes(data.quotaBytes)}` : ''}.
    </p>
  );
}

function DevicesSection({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => ipc.get<DeviceInfo[]>('/auth/devices'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => ipc.del(`/auth/devices/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <section className="card" id="settings-devices">
      <SectionHeader
        title="Signed-in devices"
        subtitle="Revoking a device signs it out immediately."
      />
      {devicesQuery.isLoading ? (
        <Loading label="Loading devices" />
      ) : (
        <ul className="people">
          {(devicesQuery.data ?? []).map((device) => (
            <li key={device.id}>
              <span>
                <strong>{device.name}</strong>
                <span className="muted small">
                  {device.platform ?? 'unknown'} · last seen {formatRelative(device.lastSeenAt)}
                </span>
              </span>
              {device.isCurrent ? (
                <Badge tone="info">This device</Badge>
              ) : (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => revokeMutation.mutate(device.id)}
                  aria-label={`Revoke ${device.name}`}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What became of the problems you reported.
 *
 * The half of bug reporting that decides whether anyone does it twice. Someone
 * who reports something and never learns whether it was read, fixed, or was
 * never a bug at all has no reason to bother again.
 */
function MyReportsSection() {
  const reportsQuery = useQuery({
    queryKey: ['bugs', 'mine'],
    queryFn: () => ipc.get<BugReportInfo[]>('/bugs/mine'),
  });

  const reports = reportsQuery.data ?? [];

  return (
    <section className="card" id="settings-reports">
      <SectionHeader
        title="Your reports"
        subtitle="Problems you have reported, and what happened to them."
      />

      {reportsQuery.isLoading ? (
        <Loading label="Loading your reports" />
      ) : reports.length === 0 ? (
        <p className="muted">
          Nothing yet. "Report a problem" in the sidebar sends one from wherever you are.
        </p>
      ) : (
        <ul className="report-list">
          {reports.map((report) => (
            <li key={report.id}>
              <span className="report-head">
                <strong>{report.title}</strong>
                <span className={`badge ${report.status === 'fixed' ? 'success' : 'neutral'}`}>
                  {BUG_STATUS_LABELS[report.status]}
                </span>
              </span>
              <span className="muted small">{formatRelative(report.createdAt)}</span>
              {report.reply ? <span className="report-reply">{report.reply}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
