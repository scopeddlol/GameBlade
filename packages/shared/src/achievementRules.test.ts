import { describe, expect, it } from 'vitest';
import { evaluateRules, sourcesFor, type AchievementRule } from './achievementRules.js';

const rule = (over: Partial<AchievementRule> = {}): AchievementRule => ({
  achievementKey: 'first_blood',
  sourceTemplate: '{install}\\save\\stats.json',
  format: 'json',
  selector: 'stats.kills',
  comparator: 'at-least',
  value: '1',
  ...over,
});

/**
 * Reading a game's own files to decide what it unlocked.
 *
 * These files are written by games, not by us. Every case below is something a
 * real save or log does, and none of them may throw: a rule that cannot be
 * read reports "not unlocked" and leaves the other rules alone.
 */
describe('evaluateRules', () => {
  it('reads a nested JSON value', () => {
    const [outcome] = evaluateRules([rule()], JSON.stringify({ stats: { kills: 5 } }));
    expect(outcome).toEqual({ achievementKey: 'first_blood', unlocked: true, found: '5' });
  });

  it('does not fire below the threshold', () => {
    const [outcome] = evaluateRules([rule()], JSON.stringify({ stats: { kills: 0 } }));
    expect(outcome?.unlocked).toBe(false);
  });

  it('indexes into arrays', () => {
    const [outcome] = evaluateRules(
      [rule({ selector: 'runs.2.won', comparator: 'truthy', value: null })],
      JSON.stringify({ runs: [{ won: false }, { won: false }, { won: true }] }),
    );
    expect(outcome?.unlocked).toBe(true);
  });

  it('treats a missing file as nothing unlocked', () => {
    // The ordinary state before a game has ever been played.
    const [outcome] = evaluateRules([rule()], null);
    expect(outcome).toEqual({ achievementKey: 'first_blood', unlocked: false, found: null });
  });

  it('survives a half-written save', () => {
    // A game still running may be mid-write when this reads.
    const [outcome] = evaluateRules([rule()], '{"stats": {"kills": 5');
    expect(outcome?.unlocked).toBe(false);
  });

  it('survives a path into something that is not an object', () => {
    const [outcome] = evaluateRules(
      [rule({ selector: 'stats.kills.deeper' })],
      '{"stats":{"kills":5}}',
    );
    expect(outcome?.unlocked).toBe(false);
  });

  describe('ini', () => {
    const ini = `; a comment
[Progress]
BossesKilled = 3
Finished="yes"

[Other]
BossesKilled = 99
`;

    it('reads a key from the right section', () => {
      const [outcome] = evaluateRules(
        [
          rule({
            format: 'ini',
            selector: 'Progress.BossesKilled',
            comparator: 'at-least',
            value: '3',
          }),
        ],
        ini,
      );
      expect(outcome).toMatchObject({ unlocked: true, found: '3' });
    });

    it('does not read the same key out of another section', () => {
      const [outcome] = evaluateRules(
        [
          rule({
            format: 'ini',
            selector: 'Progress.BossesKilled',
            comparator: 'at-least',
            value: '99',
          }),
        ],
        ini,
      );
      expect(outcome?.unlocked).toBe(false);
    });

    it('unquotes a value', () => {
      const [outcome] = evaluateRules(
        [
          rule({
            format: 'ini',
            selector: 'Progress.Finished',
            comparator: 'equals',
            value: 'yes',
          }),
        ],
        ini,
      );
      expect(outcome?.unlocked).toBe(true);
    });

    it('ignores case in section and key names', () => {
      const [outcome] = evaluateRules(
        [
          rule({
            format: 'ini',
            selector: 'progress.bosseskilled',
            comparator: 'present',
            value: null,
          }),
        ],
        ini,
      );
      expect(outcome?.unlocked).toBe(true);
    });
  });

  describe('text', () => {
    it('captures a group from a log line', () => {
      const [outcome] = evaluateRules(
        [
          rule({
            format: 'text',
            selector: 'Level (\\d+) complete',
            comparator: 'at-least',
            value: '10',
          }),
        ],
        'Level 3 complete\nLevel 12 complete\n',
      );
      // The first match wins; a log is read for the earliest evidence.
      expect(outcome?.found).toBe('3');
    });

    it('counts a bare match as present', () => {
      const [outcome] = evaluateRules(
        [rule({ format: 'text', selector: 'ENDING_REACHED', comparator: 'present', value: null })],
        'stuff\nENDING_REACHED\n',
      );
      expect(outcome?.unlocked).toBe(true);
    });

    it('does not throw on an invalid regular expression', () => {
      // An operator typo must not take the whole evaluation down.
      const [outcome] = evaluateRules(
        [rule({ format: 'text', selector: '([unclosed', comparator: 'present', value: null })],
        'anything',
      );
      expect(outcome?.unlocked).toBe(false);
    });
  });

  describe('truthy', () => {
    it.each(['1', 'true', 'yes', 'on', 'YES'])('treats %s as unlocked', (value) => {
      const [outcome] = evaluateRules(
        [rule({ selector: 'done', comparator: 'truthy', value: null })],
        JSON.stringify({ done: value }),
      );
      expect(outcome?.unlocked).toBe(true);
    });

    it.each(['0', 'false', 'no', 'off', ''])('treats %s as still locked', (value) => {
      const [outcome] = evaluateRules(
        [rule({ selector: 'done', comparator: 'truthy', value: null })],
        JSON.stringify({ done: value }),
      );
      expect(outcome?.unlocked).toBe(false);
    });

    it('treats a real boolean false as still locked', () => {
      const [outcome] = evaluateRules(
        [rule({ selector: 'done', comparator: 'truthy', value: null })],
        JSON.stringify({ done: false }),
      );
      expect(outcome?.unlocked).toBe(false);
    });
  });

  it('evaluates every rule even when one of them cannot be read', () => {
    const outcomes = evaluateRules(
      [
        rule({ achievementKey: 'a', selector: 'missing.thing' }),
        rule({ achievementKey: 'b', selector: 'stats.kills' }),
      ],
      JSON.stringify({ stats: { kills: 9 } }),
    );
    expect(outcomes.map((o) => o.unlocked)).toEqual([false, true]);
  });
});

describe('sourcesFor', () => {
  it('lists each file once so it is read once', () => {
    expect(
      sourcesFor([
        rule({ achievementKey: 'a', sourceTemplate: '{install}\\a.json' }),
        rule({ achievementKey: 'b', sourceTemplate: '{install}\\a.json' }),
        rule({ achievementKey: 'c', sourceTemplate: '{appdata}\\b.ini' }),
      ]),
    ).toEqual(['{install}\\a.json', '{appdata}\\b.ini']);
  });
});
