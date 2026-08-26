import type { SaveRule } from '@gameblade/shared';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { ipc, type ClientSettings, type InstalledGame, type SaveRulePayload } from '../lib/ipc.js';

/** What the rules endpoint answers with; only the save half is used here. */
interface Rules {
  save: SaveRule[];
}

/**
 * How long after a game exits before its save is packed.
 *
 * Games write their save on the way out, and the process is gone before
 * Windows has finished flushing it. Packing the instant the watcher notices the
 * exit is how you upload the save from *before* the session — which is worse
 * than not uploading at all, because it overwrites the good copy in the cloud
 * with a stale one.
 */
const SETTLE_MS = 3_000;

function toPayload(rule: SaveRule): SaveRulePayload {
  return { pathTemplate: rule.pathTemplate, include: rule.include, exclude: rule.exclude };
}

/**
 * Keeps a game's save in the cloud without anybody pressing a button.
 *
 * The setting has said "pull before launching and push after quitting" since
 * the client was written, and only the first half of that ever happened. So a
 * player who trusted it had a cloud save frozen at whenever they last thought
 * to press Upload — and, worse, one that a fresh install would helpfully
 * restore over their real progress.
 *
 * Three moments, because a save is lost at all three: when the game closes,
 * periodically during a long session, and on start-up for whatever the last
 * session never managed to send.
 *
 * Everything here fails silently. An upload that cannot happen is not worth
 * interrupting somebody's evening over — the save is still on disk, and the
 * next of the three moments tries again.
 */
export function useAutoSync(settings: ClientSettings | undefined, enabled: boolean): void {
  // Held in a ref so the listener registered below always reads the current
  // preferences rather than the ones in scope when it was attached.
  const current = useRef(settings);
  current.current = settings;

  const caughtUp = useRef(false);

  /* ------------------------------------------------------ when a game exits */

  useEffect(() => {
    if (!enabled) return;

    const unlisten = listen<{ gameId: string }>('play://ended', (event) => {
      const config = current.current;
      if (!config?.syncSaves || !config.autoSyncOnExit) return;

      // Deliberately after a pause: the game is only just gone, and its last
      // write may not have reached the disk.
      const timer = setTimeout(() => {
        void pushGame(event.payload.gameId);
      }, SETTLE_MS);

      // Nothing cancels this — the app closing takes the timer with it, and a
      // sync that did not happen is caught by the start-up sweep next time.
      void timer;
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [enabled]);

  /* ------------------------------------------------- periodically, mid-game */

  useEffect(() => {
    const minutes = settings?.autoSyncIntervalMinutes ?? 0;
    if (!enabled || !settings?.syncSaves || minutes <= 0) return;

    const timer = setInterval(() => {
      void (async () => {
        // Only while something is actually running: an idle client has
        // nothing new to send, and packing a save folder is real work.
        const running = await ipc.runningGame().catch(() => null);
        if (running) await pushGame(running.gameId);
      })();
    }, minutes * 60_000);

    return () => clearInterval(timer);
  }, [enabled, settings?.syncSaves, settings?.autoSyncIntervalMinutes]);

  /* ------------------------------------------------------ catching up, once */

  useEffect(() => {
    if (!enabled || !settings?.syncSaves || !settings.autoSyncOnStart) return;
    if (caughtUp.current) return;
    caughtUp.current = true;

    void catchUp();
  }, [enabled, settings?.syncSaves, settings?.autoSyncOnStart]);
}

/**
 * Uploads one game's save, if it has a rule and there is anything to send.
 *
 * The status check is not an optimisation. Pushing unconditionally would
 * create a cloud version per game exit whether or not the save changed, and
 * would overwrite a newer cloud copy with an older local one after a session
 * where nothing was saved.
 */
async function pushGame(gameId: string): Promise<void> {
  try {
    const rules = await ipc.get<Rules>(`/games/${gameId}/rules`);
    const rule = rules.save[0];
    if (!rule) return;

    const status = await ipc.saveStatus(gameId, toPayload(rule));
    if (!status.local) return;

    // 'conflict' is deliberately absent: both sides changed, and choosing for
    // somebody automatically is how a save gets lost. The game's page shows it
    // and lets them decide.
    if (status.remote.state !== 'local-newer' && status.remote.state !== 'no-remote') return;

    await ipc.pushSave(gameId, toPayload(rule), false);
  } catch {
    // Offline, no rule, an unreadable folder — none of it is worth a dialog.
  }
}

/**
 * Sends whatever the last session did not.
 *
 * A crash, a power cut, or closing the launcher while a game was still running
 * all end with a save on disk that the cloud never saw. This is the sweep that
 * notices, and it is why "automatic" can be trusted at all: without it the
 * guarantee is only as good as the client's last clean exit.
 *
 * One game at a time on purpose. A library of two hundred installed games
 * would otherwise open two hundred parallel packs and uploads the moment the
 * app started, which is the worst possible first impression of a feature meant
 * to be invisible.
 */
async function catchUp(): Promise<void> {
  let installed: InstalledGame[];
  try {
    installed = await ipc.listInstalled();
  } catch {
    return;
  }

  for (const game of installed) {
    await pushGame(game.gameId);
  }
}
