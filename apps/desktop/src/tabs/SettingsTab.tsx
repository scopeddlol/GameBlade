import type { DeviceInfo, ProfileDetail, SaveSlotInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, LogOut, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar, Badge, ErrorNote, Loading, SectionHeader } from '../components/ui.js';
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
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const update = (patch: Partial<ClientSettings>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    saveMutation.mutate(next);
  };

  const chooseFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Where should games be installed?',
    });
    if (typeof selected === 'string') update({ installDir: selected });
  };

  if (settingsQuery.isLoading || !draft) return <Loading label="Loading settings" />;

  return (
    <div className="tab-content settings">
      <ErrorNote message={error} />
      {notice ? <p className="notice">{notice}</p> : null}

      <ProfileSection onError={setError} />

      <section className="card">
        <SectionHeader title="Downloads and installs" />

        <label className="field">
          <span>Install location</span>
          <div className="row">
            <input className="input" value={draft.installDir} readOnly />
            <button type="button" className="btn btn-ghost" onClick={chooseFolder}>
              <FolderOpen size={15} aria-hidden />
              Change
            </button>
          </div>
        </label>

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
          label="Minimise when a game starts"
          checked={draft.minimiseOnLaunch}
          onChange={(minimiseOnLaunch) => update({ minimiseOnLaunch })}
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

function ProfileSection({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => ipc.get<ProfileDetail>('/profile'),
  });

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [accent, setAccent] = useState('#7c5cff');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    const profile = profileQuery.data;
    if (!profile || seeded) return;
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? '');
    setAccent(profile.accentColor);
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

  if (profileQuery.isLoading) return <Loading label="Loading profile" />;
  const profile = profileQuery.data;

  return (
    <section className="card">
      <SectionHeader title="Profile" />

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
        <span>Accent colour</span>
        <input
          type="color"
          className="color-input"
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
          onBlur={() => saveMutation.mutate({ accentColor: accent })}
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
