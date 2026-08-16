import { ARCHIVE_EXTENSIONS } from '@gameblade/shared';

/** Release-group, repack and packaging noise that never helps a provider match. */
const NOISE_TOKENS = [
  'fitgirl',
  'dodi',
  'elamigos',
  'codex',
  'plaza',
  'skidrow',
  'reloaded',
  'razor1911',
  'hoodlum',
  'tenoke',
  'rune',
  'empress',
  'goldberg',
  'repack',
  'proper',
  'cracked',
  'crack',
  'preinstalled',
  'pre-installed',
  'portable',
  'standalone',
  'gog',
  'gog-classic',
  'drm-free',
  'drmfree',
  'steamrip',
  'scene',
  'nosteam',
  'incl',
  'dlcs',
  'alldlcs',
  'multi',
  'x64',
  'x86',
  'win64',
  'win32',
  'pcgame',
  'pc',
];

const NOISE_PATTERN = new RegExp(`\\b(?:${NOISE_TOKENS.join('|')})\\b`, 'gi');

/** `v1.2.3`, `v1.4.0.0`, `build 12345`, `r1234`, `update 5`, `hotfix 2`. */
const VERSION_PATTERN =
  /\b(?:v(?:er(?:sion)?)?[\s._-]?\d+(?:[._-]\d+)*|build[\s._-]?\d+|r\d{3,}|update[\s._-]?\d+|hotfix[\s._-]?\d+|patch[\s._-]?\d+(?:[._-]\d+)*)\b/gi;

/** Bracketed or parenthesised chunks: `[GOG]`, `(2015)`, `{Multi9}`. */
const BRACKET_PATTERN = /[[({][^\])}]*[\])}]/g;

/** A trailing four-digit year, e.g. `Doom 2016` keeps it, `Celeste 2018` drops it. */
const TRAILING_YEAR_PATTERN = /\s+(?:19|20)\d{2}$/;

const LEADING_ARTICLE_PATTERN = /^(?:the|a|an)\s+/i;

/** Strip a known archive extension, including two-part ones like `.tar.gz`. */
export function stripArchiveExtension(name: string): string {
  const lower = name.toLowerCase();
  // Longest first so `.tar.gz` wins over `.gz`.
  const sorted = [...ARCHIVE_EXTENSIONS].sort((a, b) => b.length - a.length);
  for (const ext of sorted) {
    if (lower.endsWith(ext)) {
      return name.slice(0, name.length - ext.length);
    }
  }
  return name;
}

/**
 * Turn a folder or archive name into a human-readable title.
 *
 * Dots are only treated as separators when the name contains no spaces at all,
 * which keeps `S.T.A.L.K.E.R. Anomaly` intact while still fixing
 * `Hades.v1.38290.Repack`.
 */
export function parseTitle(rawName: string, isArchive: boolean): string {
  let name = isArchive ? stripArchiveExtension(rawName) : rawName;

  name = name.replace(BRACKET_PATTERN, ' ');

  // Whether the original used spaces decides how dots are treated, so this is
  // measured before any separator rewriting.
  const hasSpaces = /\s/.test(name.trim());

  // Underscores go first because they are word characters: in "Valley_v1.6.8"
  // there is no word boundary before the "v", so the version would not match.
  name = name.replace(/_+/g, ' ');

  // Version markers are stripped while their dots are still intact: turning
  // "v1.6.8" into "v1 6 8" first would leave the digits stranded in the title.
  name = name.replace(VERSION_PATTERN, ' ');

  if (!hasSpaces) {
    // Preserve single-letter dotted acronyms such as S.T.A.L.K.E.R.
    if (!/(?:\b[A-Za-z]\.){3,}/.test(name)) {
      name = name.replace(/\.+/g, ' ');
    }
  }

  name = name.replace(NOISE_PATTERN, ' ');

  // Separator dashes surrounded by spaces are noise; hyphenated words are not.
  name = name.replace(/\s+[-–—]\s+/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[-–—\s]+|[-–—\s.]+$/g, '').trim();

  return name || rawName.trim();
}

/** Title used for provider lookups: no trailing year, no edition suffix noise. */
export function toSearchTitle(title: string): string {
  return title.replace(TRAILING_YEAR_PATTERN, '').replace(/\s+/g, ' ').trim();
}

/** Case- and article-insensitive key used for alphabetical ordering. */
export function toSortTitle(title: string): string {
  return title
    .replace(LEADING_ARTICLE_PATTERN, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loose comparison key for deciding whether a provider result is the same game. */
export function matchKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, '');
}
