import type { DeviceInfo, ProfileDetail, SaveSlotInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, LogOut, Star, Trash2 } from 'lucide-react';
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
import { formatBytes, formatRelative } from '../lib/format.js';
import { errorMessage, ipc, type ClientSettings } from '../lib/ipc.js';

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
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
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

      <ProfileSection onError={setError} />

      <section className="card">
        <SectionHeader
          title="Storage locations"
          subtitle="Where games install to. Installing a game offers a choice whenever more than one is set up."
        />
        <StorageLocationsField draft={draft} onUpdate={update} />
      </section>

      <section className="card">
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
            {draft.downloadConcurrency} at a time. More helps on a fast connection with many small
            files, and hurts on a slow one.
          </span>
        </label>

        <Toggle
          label="Verify downloads"
          hint="Check each file against the server's checksum after downloading."
          checked={draft.verifyDownloads}
          onChange={(verifyDownloads) => update({ verifyDownloads })}
        />
      </section>

      <section className="card">
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

      <DevicesSection onError={setError} />

      <section className="card">
        <SectionHeader title="Account" />
        <p className="muted small">
          Signed in as <strong>{session?.username}</strong> on {session?.server_url}
        </p>
        <button type="button" className="btn btn-danger" onClick={() => void signOut()}>
          <LogOut size={15} aria-hidden />
          Sign out
        </button>
      </section>
    </div>
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
