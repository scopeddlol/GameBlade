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
  Film,
  FolderOpen,
  HardDrive,
  Lock,
  Play,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDate, formatPlaytime, formatRelative } from '../lib/format.js';
import {
  errorMessage,
  ipc,
  type DownloadState,
  type InstalledGame,
  type SaveRulePayload,
} from '../lib/ipc.js';
import { useAddToLibrary } from '../hooks/useLibrary.js';
import {
  Artwork,
  Badge,
  ErrorNote,
  GameCapabilities,
  Loading,
  Modal,
  ProgressBar,
  Spinner,
} from './ui.js';
import { InstallDialog } from './InstallDialog.js';

interface Rules {
  save: SaveRule[];
  launch: LaunchRule[];
}

export function GameDetailPanel({
  gameId,
  onClose,
  installed,
  isRunning,
  download,
}: {
  gameId: string;
  onClose: () => void;
  installed: InstalledGame | undefined;
  isRunning: boolean;
  /**
   * `installMutation.isPending` only covers the IPC call that starts the
   * download — the Rust side spawns it and returns immediately, so the
   * button would flip back to a plain, clickable "Install" seconds into a
   * transfer that takes minutes. The live download state is what's actually
   * still running.
   */
  download: DownloadState | undefined;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showStoragePicker, setShowStoragePicker] = useState(false);

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

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.getSettings(),
  });

  const game = gameQuery.data;
  // On by default, and off for anyone who would rather read the title: a
  // wordmark is artwork, and some of them are hard to read at this size.
  const useLogo = Boolean(game?.art.logo) && (settingsQuery.data?.useLogoTitles ?? true);
  const saveRule = rulesQuery.data?.save[0];
  const launchRule = rulesQuery.data?.launch[0];

  const isInstalling =
    download?.status === 'queued' ||
    download?.status === 'downloading' ||
    download?.status === 'verifying';
  const installPercent =
    download && download.total_bytes > 0
      ? Math.round((download.downloaded_bytes / download.total_bytes) * 100)
      : null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['games'] });
    void queryClient.invalidateQueries({ queryKey: ['installed'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  const installMutation = useMutation({
    mutationFn: (destination?: string) => ipc.startDownload(gameId, destination),
    onSuccess: () => {
      setShowStoragePicker(false);
      setNotice('Download started — track it from the Downloads panel.');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  // Always ask. A single configured drive is still a choice worth confirming
  // when the answer is tens of gigabytes landing somewhere.
  const startInstall = () => setShowStoragePicker(true);

  const launchMutation = useMutation({
    mutationFn: async () => {
      // Pull the cloud save first, so a session never starts from a stale one —
      // unless the player turned automatic syncing off, which is the whole
      // point of that switch and until now was the one thing it did not do.
      if (saveRule && (settingsQuery.data?.syncSaves ?? true)) {
        await syncBeforeLaunch(gameId, saveRule, installed, {
          promptOnConflict: settingsQuery.data?.promptOnSaveConflict ?? true,
        });
      }
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

  // Shared with the grid's own button so both flip instantly and roll back
  // the same way.
  const addMutation = useAddToLibrary();

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
                {/* A wordmark where the game has one, and the plain title
                    otherwise. The logo is artwork drawn for exactly this job,
                    so it beats setting the name in the app's own typeface —
                    but it stays an <h1> for anything reading the page aloud. */}
                {useLogo ? (
                  <h1 className="detail-logo">
                    <Artwork path={game.art.logo} alt={game.title} className="detail-logo-img" />
                  </h1>
                ) : (
                  <h1>{game.title}</h1>
                )}
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
                    className={clsx('btn btn-primary btn-lg', isInstalling && 'btn-installing')}
                    onClick={startInstall}
                    disabled={installMutation.isPending || isInstalling || game.isMissing}
                  >
                    {isInstalling ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Download size={16} aria-hidden />
                    )}
                    {game.isMissing
                      ? 'Unavailable'
                      : isInstalling
                        ? `Installing…${installPercent === null ? '' : ` ${installPercent}%`}`
                        : installMutation.isPending
                          ? 'Starting…'
                          : download?.status === 'paused'
                            ? `Resume${installPercent === null ? '' : ` (${installPercent}%)`}`
                            : 'Install'}
                  </button>
                )}

                {!game.inLibrary ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setError(null);
                      addMutation.mutate(gameId, {
                        onError: (caught) => setError(errorMessage(caught)),
                      });
                    }}
                    disabled={addMutation.isPending}
                  >
                    Add to library
                  </button>
                ) : null}

                {installed ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      // Through the Rust command rather than the opener
                      // plugin's JS binding: `open_path` is not in the app's
                      // capability set, so calling it from here failed with
                      // "not allowed by ACL". The command already exists, runs
                      // with the app's own permissions, and checks the folder
                      // is still there before asking the OS to show it.
                      void ipc
                        .openInstallFolder(game.id)
                        .catch((caught) => setError(errorMessage(caught)));
                    }}
                  >
                    <FolderOpen size={16} aria-hidden />
                    Browse files
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
              {game.storyline && game.storyline !== game.summary ? (
                <p className="detail-summary">{game.storyline}</p>
              ) : null}

              {/* Full labels here — there is room, and this is the page
                  somebody reads before deciding to install. */}
              <GameCapabilities
                hasSaveRule={game.hasSaveRule}
                achievementCount={game.achievementCount}
                unlockedCount={game.unlockedCount}
              />

              {game.genres.length > 0 ? (
                <div className="tag-row">
                  {game.genres.map((genre) => (
                    <Badge key={genre}>{genre}</Badge>
                  ))}
                </div>
              ) : null}

              {game.screenshots.length > 0 ? (
                <ScreenshotGallery screenshots={game.screenshots} title={game.title} />
              ) : null}

              {game.videos.length > 0 ? <TrailerList videoIds={game.videos} /> : null}

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

      {showStoragePicker && game ? (
        <InstallDialog
          game={game}
          onClose={() => setShowStoragePicker(false)}
          onStarted={() => setNotice('Download started — track it from the Downloads panel.')}
        />
      ) : null}
    </div>
  );
}

function ScreenshotGallery({ screenshots, title }: { screenshots: string[]; title: string }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="detail-section">
      <h3>Screenshots</h3>
      <div className="screenshot-strip">
        {screenshots.map((path, index) => (
          <button
            key={path}
            type="button"
            className="screenshot-thumb"
            onClick={() => setOpenIndex(index)}
          >
            <Artwork path={path} alt={`${title} screenshot ${index + 1}`} />
          </button>
        ))}
      </div>

      {openIndex !== null ? (
        <Modal
          title={`${title} — screenshot ${openIndex + 1} of ${screenshots.length}`}
          onClose={() => setOpenIndex(null)}
        >
          <div className="screenshot-lightbox">
            <Artwork path={screenshots[openIndex]} alt="" />
          </div>
          {screenshots.length > 1 ? (
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  setOpenIndex((openIndex - 1 + screenshots.length) % screenshots.length)
                }
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOpenIndex((openIndex + 1) % screenshots.length)}
              >
                Next
              </button>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}

function TrailerList({ videoIds }: { videoIds: string[] }) {
  return (
    <section className="detail-section">
      <h3>
        <Film size={16} aria-hidden /> Trailers
      </h3>
      <div className="trailer-strip">
        {videoIds.map((id) => (
          <button
            key={id}
            type="button"
            className="trailer-card"
            onClick={() => void ipc.openExternal(`https://www.youtube.com/watch?v=${id}`)}
            title="Watch on YouTube"
          >
            <img src={`https://img.youtube.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
            <span className="trailer-play">
              <Play size={20} aria-hidden />
            </span>
          </button>
        ))}
      </div>
    </section>
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
 * settle deliberately. Unless they have said they would rather not be asked,
 * which is what the setting of that name has always offered and never done.
 */
async function syncBeforeLaunch(
  gameId: string,
  rule: SaveRule,
  installed: InstalledGame | undefined,
  options: { promptOnConflict: boolean },
): Promise<void> {
  if (!installed) return;
  try {
    const status = await ipc.saveStatus(gameId, toPayload(rule));
    const slotId = status.remote.slotId;
    if (!slotId) return;

    if (status.remote.state === 'remote-newer') {
      await ipc.pullSave(gameId, toPayload(rule), slotId);
      return;
    }

    // With "ask before overwriting" turned off, the setting promises to take
    // whichever copy was captured later — so a conflict is settled here rather
    // than waiting in the drawer for someone who has said they do not want to
    // be asked. The other copy stays in the cloud's version history either way,
    // so nothing is destroyed by getting this wrong.
    if (status.remote.state === 'conflict' && !options.promptOnConflict) {
      const remoteAt = status.remote.remote?.capturedAt;
      const localAt = status.local?.capturedAt;
      if (remoteAt && (!localAt || Date.parse(remoteAt) > Date.parse(localAt))) {
        await ipc.pullSave(gameId, toPayload(rule), slotId);
      }
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
