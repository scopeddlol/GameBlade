/**
 * Deciding, from a file a game wrote, which achievements are unlocked.
 *
 * The reading happens on the player's machine — the file is theirs and never
 * leaves it — so this runs in the desktop client. It lives here rather than
 * there so it can be tested without a Windows box and a copy of the game.
 *
 * Everything is deliberately forgiving. These files are written by games, not
 * by us: a rule that points at the wrong key, a save that has not been created
 * yet, a log in an unexpected encoding. None of that is exceptional, and none
 * of it should stop the other rules for the same game from being evaluated.
 */

/** How the watched file is read. */
export const ACHIEVEMENT_FORMATS = ['json', 'ini', 'text'] as const;
export type AchievementFormat = (typeof ACHIEVEMENT_FORMATS)[number];

/** What makes the rule fire. */
export const ACHIEVEMENT_COMPARATORS = ['present', 'truthy', 'equals', 'at-least'] as const;
export type AchievementComparator = (typeof ACHIEVEMENT_COMPARATORS)[number];

export interface AchievementRule {
  /** The achievement this unlocks, matching a definition's key. */
  achievementKey: string;
  /** Where the file is, in the same template vocabulary as save rules. */
  sourceTemplate: string;
  format: AchievementFormat;
  /**
   * What to look at.
   *
   * `json`  a dotted path, e.g. `stats.bossesKilled`; array indices allowed.
   * `ini`   `section.key`, or just `key` for a file with no sections.
   * `text`  a regular expression; the first capture group is the value, and
   *         with no group the match itself counts as present.
   */
  selector: string;
  comparator: AchievementComparator;
  /** The operand for `equals` and `at-least`; ignored by the others. */
  value: string | null;
}

/** What a rule decided, and why, so an operator can see it working. */
export interface RuleOutcome {
  achievementKey: string;
  unlocked: boolean;
  /** What was read, for showing in a test view. Null when nothing matched. */
  found: string | null;
}

/** Walks a dotted path, tolerating arrays and missing links. */
function readJsonPath(root: unknown, selector: string): unknown {
  let current = root;
  for (const segment of selector.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Reads one key out of INI-ish text.
 *
 * Written against what games actually produce rather than any specification:
 * `;` and `#` comments, sections in brackets, values that may be quoted, and
 * duplicate keys where the last one wins.
 */
function readIniKey(text: string, selector: string): string | undefined {
  const [wantedSection, wantedKey] = selector.includes('.')
    ? [selector.slice(0, selector.lastIndexOf('.')), selector.slice(selector.lastIndexOf('.') + 1)]
    : [null, selector];

  let section: string | null = null;
  let found: string | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim();
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (key.toLowerCase() !== wantedKey?.toLowerCase()) continue;
    if (wantedSection !== null && (section ?? '').toLowerCase() !== wantedSection.toLowerCase()) {
      continue;
    }

    const value = line.slice(separator + 1).trim();
    found = value.replace(/^"(.*)"$/, '$1');
  }

  return found;
}

/** Pulls the value a rule cares about out of the file, or undefined. */
function extract(rule: AchievementRule, contents: string): string | undefined {
  if (rule.format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      // A half-written save is normal if the game is still running.
      return undefined;
    }
    const found = readJsonPath(parsed, rule.selector);
    if (found === undefined || found === null) return undefined;
    return typeof found === 'object' ? JSON.stringify(found) : String(found);
  }

  if (rule.format === 'ini') return readIniKey(contents, rule.selector);

  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.selector, 'm');
  } catch {
    // An operator's typo in a regular expression must not throw here; the
    // rule simply never fires, and the test view shows nothing found.
    return undefined;
  }
  const match = pattern.exec(contents);
  if (!match) return undefined;
  return match[1] ?? match[0];
}

/** Whether a value read from the file satisfies the rule. */
function satisfies(rule: AchievementRule, found: string): boolean {
  switch (rule.comparator) {
    case 'present':
      return true;

    case 'truthy': {
      // Games write all of these for "yes", and JSON.parse would reject most.
      const normalized = found.trim().toLowerCase();
      return !['', '0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized);
    }

    case 'equals':
      return rule.value !== null && found.trim() === rule.value.trim();

    case 'at-least': {
      const threshold = Number(rule.value);
      const actual = Number(found);
      return Number.isFinite(threshold) && Number.isFinite(actual) && actual >= threshold;
    }

    default:
      return false;
  }
}

/**
 * Evaluates every rule that reads a given file.
 *
 * `contents` is null when the file does not exist, which is the ordinary state
 * before a game has ever been played — every rule simply reports not unlocked.
 */
export function evaluateRules(rules: AchievementRule[], contents: string | null): RuleOutcome[] {
  return rules.map((rule) => {
    if (contents === null) {
      return { achievementKey: rule.achievementKey, unlocked: false, found: null };
    }
    const found = extract(rule, contents);
    return {
      achievementKey: rule.achievementKey,
      unlocked: found === undefined ? false : satisfies(rule, found),
      found: found ?? null,
    };
  });
}

/** The distinct files a set of rules needs, so each is read once. */
export function sourcesFor(rules: AchievementRule[]): string[] {
  return [...new Set(rules.map((rule) => rule.sourceTemplate))];
}
