import { describe, expect, it } from 'vitest';
import { deriveSaveTemplates, saveTemplateFromSource } from './achievementRules.js';

/**
 * Turning an unlock rule back into the save rule it implies.
 *
 * The premise: an achievement rule reads a file the game wrote into its own
 * save folder, so a catalog with unlock rules and no cloud saves has already
 * recorded where the saves are — in the wrong column.
 */
describe('saveTemplateFromSource', () => {
  it('takes the folder holding the watched file', () => {
    expect(
      saveTemplateFromSource('{appdata}\\Goldberg SteamEmu Saves\\480\\achievements.json'),
    ).toBe('{appdata}\\Goldberg SteamEmu Saves\\480');
  });

  it('accepts forward slashes and answers in the authored form', () => {
    expect(saveTemplateFromSource('{documents}/My Game/save/progress.ini')).toBe(
      '{documents}\\My Game\\save',
    );
  });

  it('stops at the first wildcard, which describes a shape rather than a place', () => {
    expect(saveTemplateFromSource('{appdata}\\Game\\*\\progress.json')).toBe('{appdata}\\Game');
  });

  it('refuses a bare filename, which points at nothing syncable', () => {
    expect(saveTemplateFromSource('achievements.json')).toBeNull();
    expect(saveTemplateFromSource('{appdata}')).toBeNull();
  });
});

describe('deriveSaveTemplates', () => {
  it('counts the rules that share a folder', () => {
    const derived = deriveSaveTemplates([
      '{appdata}\\Game\\stats.json',
      '{appdata}\\Game\\achievements.json',
    ]);
    expect(derived).toEqual([{ pathTemplate: '{appdata}\\Game', ruleCount: 2 }]);
  });

  it('folds a nested folder into the parent rather than proposing both', () => {
    const derived = deriveSaveTemplates([
      '{appdata}\\Game\\stats.json',
      '{appdata}\\Game\\slots\\slot1.sav',
    ]);
    expect(derived).toEqual([{ pathTemplate: '{appdata}\\Game', ruleCount: 2 }]);
  });

  it('keeps genuinely separate layouts apart, so an operator picks', () => {
    const derived = deriveSaveTemplates([
      '{appdata}\\Goldberg SteamEmu Saves\\480\\achievements.json',
      '{documents}\\My Game\\save.dat',
    ]);
    expect(derived).toHaveLength(2);
  });

  it('ignores sources that imply nothing', () => {
    expect(deriveSaveTemplates(['achievements.json'])).toEqual([]);
  });
});
