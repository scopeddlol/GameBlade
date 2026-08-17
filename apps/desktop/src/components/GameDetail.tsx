import type {
  AchievementProgress,
  GameDetail as GameDetailType,
  LaunchRule,
  SaveRule,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CloudDownload,
  CloudUpload,
  Download,
  HardDrive,
  Lock,
  Play,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDate, formatPlaytime, formatRelative } from '../lib/format.js';
import { errorMessage, ipc, type InstalledGame, type SaveRulePayload } from '../lib/ipc.js';
import { Artwork, Badge, ErrorNote, Loading, ProgressBar } from './ui.js';

interface Rules {
  save: SaveRule[];
  launch: LaunchRule[];
}

export function GameDetailPanel({
  gameId,
  onClose,
  installed,
  isRunning,
}: {
  gameId: string;
  onClose: () => void;
  installed: InstalledGame | undefined;
  isRunning: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const gameQuery = useQuery({
    queryKey: ['games', gameId],
    queryFn: () => ipc.get<GameDetailType>(`/games/${gameId}`),
  });

  const achievementsQuery = useQuery({
    queryKey: ['achievements', gameId],
    queryFn: () => ipc.get<AchievementProgress[]>(`/games/${gameId}/achievements`),
  });

  const rulesQuery = useQuery({
    queryKey: ['rules', gameId],
    queryFn: () => ipc.get<Rules>(`/games/${gameId}/rules`),
  });

  const game = gameQuery.data;
  const saveRule = rulesQuery.data?.save[0];
  const launchRule = rulesQuery.data?.launch[0];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['games'] });
    void queryClient.invalidateQueries({ queryKey: ['installed'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  const installMutation = useMutation({
    mutationFn: () => ipc.startDownload(gameId),
    onSuccess: () => {
      setNotice('Download started — track it from the Downloads panel.');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      // Pull the cloud save first, so a session never starts from a stale one.
      if (saveRule) await syncBeforeLaunch(gameId, saveRule, installed);
      return ipc.launch(gameId, {
        executableOverride: launchRule?.executable ?? undefined,
        args: launchRule?.args ?? undefined,
        workingDir: launchRule?.workingDir ?? undefined,
      });
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['running'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const addMutation = useMutation({
    mutationFn: () => ipc.post(`/games/${gameId}/library`),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const uninstallMutation = useMutation({
    mutationFn: () => ipc.uninstall(gameId),
    onSuccess: () => {
      setNotice('Uninstalled. Your cloud saves were left untouched.');
      refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          <X size={18} aria-hidden />
        </button>

        {gameQuery.isLoading || !game ? (
          <Loading label="Loading game" />
        ) : (
          <>
            <div className="detail-hero">
              <Artwork path={game.art.hero ?? game.art.cover} alt="" className="hero-img" />
              <div className="detail-hero-overlay" />
              <div className="detail-hero-text">
                <h1>{game.title}</h1>
                <p className="muted">
                  {[
                    game.developers[0],
                    game.releaseDate ? formatDate(game.releaseDate) : null,
                    formatBytes(game.sizeBytes),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>

            <div className="detail-body">
              <ErrorNote message={error} />
              {notice ? <p className="notice">{notice}</p> : null}

              <div className="detail-actions">
                {installed ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={() => launchMutation.mutate()}
                    disabled={isRunning || launchMutation.isPending}
                  >
                    <Play size={16} aria-hidden />
                    {isRunning ? 'Running' : launchMutation.isPending ? 'Starting…' : 'Play'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={() => installMutation.mutate()}
                    disabled={installMutation.isPending || game.isMissing}
                  >
                    <Download size={16} aria-hidden />
                    {game.isMissing ? 'Unavailable' : 'Install'}
                  </button>
                )}

                {!game.inLibrary ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => addMutation.mutate()}
                    disabled={addMutation.isPending}
                  >
                    Add to library
                  </button>
                ) : null}

                {installed ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => uninstallMutation.mutate()}
                    disabled={isRunning || uninstallMutation.isPending}
                  >
                    <Trash2 size={16} aria-hidden />
                    Uninstall
                  </button>
                ) : null}
              </div>

              <div className="detail-stats">
                <Stat label="Playtime" value={formatPlaytime(game.playSeconds)} />
                <Stat label="Last played" value={formatRelative(game.lastPlayedAt)} />
                {game.achievementCount > 0 ? (
                  <Stat
                    label="Achievements"
                    value={`${game.unlockedCount} of ${game.achievementCount}`}
                  />
                ) : null}
                {installed ? (
                  <Stat label="On disk" value={formatBytes(installed.sizeBytes)} />
                ) : null}
              </div>

              {game.summary ? <p className="detail-summary">{game.summary}</p> : null}

              {game.genres.length > 0 ? (
                <div className="tag-row">
                  {game.genres.map((genre) => (
                    <Badge key={genre}>{genre}</Badge>
                  ))}
                </div>
              ) : null}

              {installed && saveRule ? (
                <SaveSyncSection gameId={gameId} rule={saveRule} onError={setError} />
              ) : installed ? (
                <section className="detail-section">
                  <h3>Cloud saves</h3>
                  <p className="muted small">
                    No save location has been configured for this game yet. An administrator can add
                    one from the web panel.
                  </p>
                </section>
              ) : null}

              <AchievementSection
                achievements={achievementsQuery.data ?? []}
                loading={achievementsQuery.isLoading}
              />

              {installed?.installPath ? (
                <section className="detail-section">
                  <h3>Installed at</h3>
                  <p className="path">
                    <HardDrive size={14} aria-hidden />
                    {installed.installPath}
                  </p>
                </section>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function toPayload(rule: SaveRule): SaveRulePayload {
  return {
    pathTemplate: rule.pathTemplate,
    include: rule.include,
    exclude: rule.exclude,
  };
}

/**
 * Pulls a newer cloud save before the game starts.
 *
 * A conflict is deliberately *not* resolved here — starting a game is the wrong
 * moment to make someone choose which save to destroy, so the launch proceeds
 * on the local copy and the drawer keeps showing the conflict for them to
 * settle deliberately.
 */
async function syncBeforeLaunch(
  gameId: string,
  rule: SaveRule,
  installed: InstalledGame | undefined,
): Promise<void> {
  if (!installed) return;
  try {
    const status = await ipc.saveStatus(gameId, toPayload(rule));
    if (status.remote.state === 'remote-newer' && status.remote.slotId) {
      await ipc.pullSave(gameId, toPayload(rule), status.remote.slotId);
    }
  } catch {
    // A sync failure must never block play; the save is still on disk.
  }
}

function SaveSyncSection({
  gameId,
  rule,
  onError,
}: {
  gameId: string;
  rule: SaveRule;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const payload = toPayload(rule);

  const statusQuery = useQuery({
    queryKey: ['saves', gameId],
    queryFn: () => ipc.saveStatus(gameId, payload),
    // A stale verdict is worse than none — it could send a save the wrong way.
    staleTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['saves', gameId] });

  const pushMutation = useMutation({
    mutationFn: (force: boolean) => ipc.pushSave(gameId, payload, force),
    onSuccess: refresh,
    onError: (caught) => onError(errorMessage(caught)),
  });

  const pullMutation = useMutation({
    mutationFn: (slotId: string) => ipc.pullSave(gameId, payload, slotId),
    onSuccess: refresh,
    onError: (caught) => onError(errorMessage(caught)),
  });

  const status = statusQuery.data;
  const state = status?.remote.state;
  const slotId = status?.remote.slotId;

  return (
    <section className="detail-section">
      <h3>Cloud saves</h3>

      {statusQuery.isLoading ? (
        <Loading label="Checking saves" />
      ) : (
        <>
          <div className="save-status">
            <Badge
              tone={
                state === 'conflict'
                  ? 'danger'
                  : state === 'in-sync'
                    ? 'success'
                    : state === 'no-remote' || state === 'no-local'
                      ? 'neutral'
                      : 'warning'
              }
            >
              {describeSaveState(state)}
            </Badge>
            {status?.local ? (
              <span className="muted small">
                {status.local.fileCount} files · {formatBytes(status.local.sizeBytes)} · captured{' '}
                {formatRelative(status.local.capturedAt)}
              </span>
            ) : (
              <span className="muted small">Nothing saved on this machine yet</span>
            )}
          </div>

          {status?.remote.remote ? (
            <p className="muted small">
              Cloud copy from {status.remote.remote.deviceName ?? 'another device'},{' '}
              {formatRelative(status.remote.remote.capturedAt)} ·{' '}
              {formatBytes(status.remote.remote.sizeBytes)}
            </p>
          ) : null}

          {state === 'conflict' ? (
            <p className="conflict-note">
              This save changed here <em>and</em> on another device since the last sync. Pick which
              copy to keep — the other one stays in the cloud version history either way.
            </p>
          ) : null}

          <div className="detail-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => pushMutation.mutate(state === 'conflict')}
              disabled={!status?.local || pushMutation.isPending}
            >
              <CloudUpload size={15} aria-hidden />
              {state === 'conflict' ? 'Keep this machine’s' : 'Upload'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => slotId && pullMutation.mutate(slotId)}
              disabled={!slotId || !status?.remote.remote || pullMutation.isPending}
            >
              <CloudDownload size={15} aria-hidden />
              {state === 'conflict' ? 'Keep the cloud’s' : 'Download'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function describeSaveState(state: string | undefined): string {
  switch (state) {
    case 'in-sync':
      return 'Up to date';
    case 'local-newer':
      return 'This machine is ahead';
    case 'remote-newer':
      return 'The cloud is ahead';
    case 'conflict':
      return 'Conflict';
    case 'no-remote':
      return 'Never uploaded';
    case 'no-local':
      return 'Not on this machine';
    default:
      return 'Unknown';
  }
}

function AchievementSection({
  achievements,
  loading,
}: {
  achievements: AchievementProgress[];
  loading: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  if (loading) return <Loading label="Loading achievements" />;
  if (achievements.length === 0) return null;

  const unlocked = achievements.filter((a) => a.unlockedAt !== null);
  const percent = (unlocked.length / achievements.length) * 100;
  const visible = showAll ? achievements : achievements.slice(0, 8);

  return (
    <section className="detail-section">
      <h3>
        <Trophy size={16} aria-hidden /> Achievements
        <span className="muted small">
          {unlocked.length} of {achievements.length}
        </span>
      </h3>

      <ProgressBar value={percent} />

      <ul className="achievement-list">
        {visible.map((achievement) => (
          <li
            key={achievement.id}
            className={clsx('achievement', achievement.unlockedAt === null && 'locked')}
          >
            <span className="achievement-icon">
              {achievement.iconUrl ? (
                <img src={achievement.iconUrl} alt="" loading="lazy" />
              ) : (
                <Trophy size={16} aria-hidden />
              )}
              {achievement.unlockedAt === null ? (
                <Lock size={11} className="lock-badge" aria-hidden />
              ) : null}
            </span>

            <span className="achievement-text">
              <strong>{achievement.name}</strong>
              {achievement.description ? (
                <span className="muted small">{achievement.description}</span>
              ) : null}
            </span>

            <span className="achievement-meta muted small">
              {achievement.unlockedAt
                ? formatRelative(achievement.unlockedAt)
                : achievement.globalPercent !== null
                  ? `${achievement.globalPercent}%`
                  : ''}
            </span>
          </li>
        ))}
      </ul>

      {achievements.length > 8 ? (
        <button type="button" className="btn btn-ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${achievements.length}`}
        </button>
      ) : null}
    </section>
  );
}
