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
  LogOut,
  MonitorSmartphone,
  Palette,
  RotateCcw,
  Star,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  Artwork,
  Avatar,
  Badge,
  ErrorNote,
  Loading,
  ProgressBar,
  SectionHeader,
  CardSkeleton,
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
  const [active, setActive] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id);

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

  if (settingsQuery.isLoading || !draft) return <CardSkeleton rows={4} />;

  return (
    <div className="tab-content settings">
      <ErrorNote message={error} />
      {notice ? <p className="notice">{notice}</p> : null}

      <div className="settings-layout">
        <SettingsNav active={active} onSelect={setActive} />

        {/* Keyed on the section, so React remounts the panel and the glow that
            confirms the click plays every time rather than only on the first. */}
        <div
          key={active}
          id={`panel-${active}`}
          role="tabpanel"
          aria-labelledby={`tab-${active}`}
          className="settings-panel"
          tabIndex={-1}
        >
          {active === 'profile' ? <ProfileSection onError={setError} /> : null}

          {active === 'appearance' ? <AppearanceSection draft={draft} onUpdate={update} /> : null}

          {active === 'storage' ? (
            <section className="card">
              <SectionHeader
                title="Storage locations"
                subtitle="Where games install to. Installing a game offers a choice whenever more than one is set up."
              />
              <StorageLocationsField draft={draft} onUpdate={update} />
            </section>
          ) : null}

          {active === 'downloads' ? (
            <section className="card">
              <SectionHeader title="Downloads and installs" />

              <label className="field">
                <span>Download connections</span>
                <input
                  type="range"
                  min={1}
                  max={16}
                  value={draft.downloadConcurrency}
                  onChange={(e) => update({ downloadConcurrency: Number(e.target.value) })}
                />
                <span className="muted small">
                  {draft.downloadConcurrency} connections at a time. More helps on a fast connection
                  with many small files, and hurts on a slow one.
                </span>
              </label>

              <Toggle
                label="Verify downloads"
                hint="Check each file against the server's checksum after downloading."
                checked={draft.verifyDownloads}
                onChange={(verifyDownloads) => update({ verifyDownloads })}
              />
            </section>
          ) : null}

          {active === 'saves' ? (
            <section className="card">
              <SectionHeader title="Cloud saves" />

              <Toggle
                label="Sync saves automatically"
                hint="Keeps this machine's saves and the cloud's in step without you thinking about it. Turning it off leaves the buttons on each game's page working."
                checked={draft.syncSaves}
                onChange={(syncSaves) => update({ syncSaves })}
              />

              {/* Nested under the master switch: these describe *when* it
                  syncs, and offering them while syncing is off would be four
                  controls that do nothing. */}
              {draft.syncSaves ? (
                <div className="settings-subgroup">
                  <Toggle
                    label="Upload when a game closes"
                    hint="The other half of automatic. Without it the cloud copy stays at whenever you last pressed Upload."
                    checked={draft.autoSyncOnExit}
                    onChange={(autoSyncOnExit) => update({ autoSyncOnExit })}
                  />

                  <Toggle
                    label="Catch up on sign-in"
                    hint="Uploads anything this machine is ahead on when the app starts — a crash or a power cut ends a session with nothing sent."
                    checked={draft.autoSyncOnStart}
                    onChange={(autoSyncOnStart) => update({ autoSyncOnStart })}
                  />

                  <label className="field">
                    <span>Back up while playing</span>
                    <select
                      className="input"
                      value={draft.autoSyncIntervalMinutes}
                      onChange={(event) =>
                        update({ autoSyncIntervalMinutes: Number(event.target.value) })
                      }
                    >
                      <option value={0}>Only when the game closes</option>
                      <option value={5}>Every 5 minutes</option>
                      <option value={15}>Every 15 minutes</option>
                      <option value={30}>Every 30 minutes</option>
                      <option value={60}>Every hour</option>
                    </select>
                    <span className="muted small">
                      A long session that ends in a crash loses everything since it started.
                      Uploading part-way through costs bandwidth and, for a game that keeps its save
                      file open, can capture a half-written one.
                    </span>
                  </label>
                </div>
              ) : null}

              <Toggle
                label="Ask before overwriting"
                hint="When both this machine and the cloud have changed, choose which copy to keep instead of picking the newer one."
                checked={draft.promptOnSaveConflict}
                onChange={(promptOnSaveConflict) => update({ promptOnSaveConflict })}
              />

              <SaveUsage />
            </section>
          ) : null}

          {active === 'privacy' ? (
            <section className="card">
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
          ) : null}

          {active === 'devices' ? <DevicesSection onError={setError} /> : null}

          {active === 'reports' ? <MyReportsSection /> : null}

          {active === 'account' ? (
            <section className="card">
              <SectionHeader title="Account" />
              <p className="muted small">
                Signed in as <strong>{session?.username}</strong>
              </p>
              <button type="button" className="btn btn-danger" onClick={() => void signOut()}>
                <LogOut size={15} aria-hidden />
                Sign out
              </button>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The sections, in the order they are offered. */
const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profile', Icon: UserRound },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'storage', label: 'Storage', Icon: HardDrive },
  { id: 'downloads', label: 'Downloads', Icon: Download },
  { id: 'saves', label: 'Cloud saves', Icon: CloudUpload },
  { id: 'privacy', label: 'Privacy', Icon: EyeOff },
  { id: 'devices', label: 'Devices', Icon: MonitorSmartphone },
  { id: 'reports', label: 'Your reports', Icon: Bug },
  { id: 'account', label: 'Account', Icon: LogOut },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * Which part of settings you are looking at.
 *
 * This was a jump list over one very long page: every section rendered at
 * once, laid out in two columns, with the highlight worked out from scroll
 * position. Two columns meant the order down the page was not the order in the
 * list, so the highlight tracked something nobody could see a reason for;
 * clicking scrolled a card to somewhere in the middle of the screen and the
 * spy immediately disagreed about where that had left you; and nine entries
 * two pixels apart made a mis-click as likely as a hit.
 *
 * So it is a real tab strip now. One section is on screen, the tab that opened
 * it stays lit, and there is nothing left for scrolling to argue with. The
 * strip is a `tablist`, so arrow keys move along it and Home/End jump to the
 * ends — which is how a keyboard expects tabs to behave, and is the part that
 * gets left out when a nav is only ever clicked.
 */
function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    const step = keys[event.key];

    let next: SettingsSectionId | undefined;
    if (step !== undefined) {
      const at = SETTINGS_SECTIONS.findIndex((entry) => entry.id === active);
      // Wraps, so holding a key never dead-ends at either edge.
      next =
        SETTINGS_SECTIONS[(at + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]?.id;
    } else if (event.key === 'Home') {
      next = SETTINGS_SECTIONS[0].id;
    } else if (event.key === 'End') {
      next = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]?.id;
    }

    if (!next) return;
    event.preventDefault();
    onSelect(next);
    // The strip only ever holds one focusable tab, so the focus has to be
    // moved by hand for the next arrow press to land somewhere.
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div
      className="settings-nav"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings sections"
      onKeyDown={move}
    >
      {SETTINGS_SECTIONS.map((entry) => {
        const selected = active === entry.id;
        return (
          <button
            key={entry.id}
            id={`tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${entry.id}`}
            // Only the selected tab is in the tab order; the arrow keys reach
            // the rest. Nine stops on the way past a sidebar is not navigation.
            tabIndex={selected ? 0 : -1}
            className={clsx('settings-nav-item', selected && 'active')}
            onClick={() => onSelect(entry.id)}
          >
            <entry.Icon size={15} aria-hidden />
            {entry.label}
          </button>
        );
      })}
    </div>
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
    <section className="card">
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

      {/* Library layout is not offered here. The Library tab's own switcher
          already sets it, above the grid it changes, and it offers all three
          layouts where this copy only ever knew two — so picking one here
          silently threw away a "detailed" choice made in the place the setting
          is actually visible. Two controls for one preference, one of them
          lossy, is worse than one. */}

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
    <section className="card">
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
    <section className="card">
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
    <section className="card">
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
