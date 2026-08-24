/**
 * Where a DRM-free build actually records which achievements it has unlocked.
 *
 * Called a `store` rather than a `source` because `AchievementSource` already
 * exists and means a different axis entirely: where a *definition* came from
 * (Steam, RetroAchievements, typed by hand).
 *
 * The rule engine has always been able to express "read this file, look at this
 * key, unlock this achievement" — and nothing ever unlocked, because using it
 * meant hand-authoring one rule per achievement per game, each requiring the
 * operator to know that game's save internals. Fifty imported Steam
 * achievements meant fifty rules nobody was going to write.
 *
 * The way out is that these builds do not invent a format each. A copy of a
 * game that ships without Steam almost always carries a Steam emulator in
 * place of it, and each emulator writes achievement state to one predictable
 * path in one predictable shape, keyed by the same API names Steam publishes —
 * which is exactly what the importer already pulls down. So the rules can be
 * generated rather than typed.
 *
 * These are best-effort layouts observed across common emulators, not a
 * specification anyone publishes. That is why generating several at once is
 * the intended use: a rule whose file does not exist reads as nothing and
 * unlocks nothing, so the layouts that do not apply cost a stat() and stay
 * silent, and whichever one the player's copy actually uses is the one that
 * fires. Being wrong is cheap; being absent is what left the feature dead.
 */

import type { AchievementComparator, AchievementFormat } from './achievementRules.js';

export interface AchievementStore {
  id: string;
  /** What an operator would recognise it as. */
  label: string;
  hint: string;
  /**
   * The file, in the same template vocabulary as save rules. `{appid}` is
   * substituted with the game's Steam app id; everything else is resolved on
   * the player's machine.
   */
  template: string;
  format: AchievementFormat;
  /** Builds the selector for one achievement's API name. */
  selector: (key: string) => string;
  comparator: AchievementComparator;
  /** Whether the template needs a Steam app id to be usable. */
  needsAppId: boolean;
}

export const ACHIEVEMENT_STORES: AchievementStore[] = [
  {
    id: 'goldberg',
    label: 'Goldberg (GSE Saves)',
    hint: 'The current Goldberg emulator. Writes JSON keyed by API name.',
    template: '{appdata}\\GSE Saves\\{appid}\\achievements.json',
    format: 'json',
    // { "ACH_NAME": { "earned": true, "earned_time": 1700000000 } }
    selector: (key) => `${key}.earned`,
    comparator: 'truthy',
    needsAppId: true,
  },
  {
    id: 'goldberg-legacy',
    label: 'Goldberg (legacy path)',
    hint: 'Older Goldberg builds, before the saves folder was renamed.',
    template: '{appdata}\\Goldberg SteamEmu Saves\\{appid}\\achievements.json',
    format: 'json',
    selector: (key) => `${key}.earned`,
    comparator: 'truthy',
    needsAppId: true,
  },
  {
    id: 'codex',
    label: 'CODEX',
    hint: 'INI with one section per achievement.',
    template: '{appdata}\\Steam\\CODEX\\{appid}\\achievements.ini',
    format: 'ini',
    // [ACH_NAME]
    // Achieved=1
    selector: (key) => `${key}.Achieved`,
    comparator: 'truthy',
    needsAppId: true,
  },
  {
    id: 'rune',
    label: 'RUNE',
    hint: 'Same INI shape as CODEX, under its own folder.',
    template: '{appdata}\\Steam\\RUNE\\{appid}\\achievements.ini',
    format: 'ini',
    selector: (key) => `${key}.Achieved`,
    comparator: 'truthy',
    needsAppId: true,
  },
  {
    id: 'smartsteamemu',
    label: 'SmartSteamEmu',
    hint: 'One [Achievements] section, key per achievement.',
    template: '{appdata}\\SmartSteamEmu\\{appid}\\achievements.ini',
    format: 'ini',
    // [Achievements]
    // ACH_NAME=1
    selector: (key) => `Achievements.${key}`,
    comparator: 'truthy',
    needsAppId: true,
  },
  {
    id: 'goldberg-portable',
    label: 'Goldberg, beside the game',
    hint: 'Portable builds that keep their emulator saves in the install folder.',
    template: '{install}\\steam_settings\\achievements.json',
    format: 'json',
    selector: (key) => `${key}.earned`,
    comparator: 'truthy',
    needsAppId: false,
  },
];

/** Substitutes the app id into a source's template. */
export function resolveStoreTemplate(store: AchievementStore, steamAppId: number | null): string {
  if (!store.needsAppId) return store.template;
  if (steamAppId === null) return store.template;
  return store.template.split('{appid}').join(String(steamAppId));
}

/** The stores that can be used for a game, given what is known about it. */
export function usableStores(steamAppId: number | null): AchievementStore[] {
  return ACHIEVEMENT_STORES.filter((store) => !store.needsAppId || steamAppId !== null);
}
