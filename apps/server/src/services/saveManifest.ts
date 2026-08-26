import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchKey } from '../lib/titles.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Where save files live, for tens of thousands of games.
 *
 * Ludusavi publishes a machine-readable digest of PCGamingWiki's save-path
 * data. It is the difference between an operator playing every game to find out
 * where it saved and confirming a suggestion the server already made.
 */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';

/**
 * How old the cached index may get before it counts as stale.
 *
 * A day. Upstream publishes continuously, and the server now refreshes on this
 * same figure rather than waiting for an operator to press the button — so an
 * index that has aged past it means the scheduled pull has not run yet, not
 * that nobody has been looking after it.
 */
export const MANIFEST_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A parse that finds fewer than this many games did not understand the file.
 *
 * Upstream is a third party who may change their format. Without a floor a
 * failed parse would quietly replace a good index with an empty one, and every
 * suggestion would silently stop appearing rather than reporting a problem.
 *
 * The real figure is around 19,700 of upstream's 53,000 entries — most of the
 * rest carry no `files:` at all, being in the manifest for their store ID or
 * install directory alone. The floor sits well under that so upstream can
 * prune without crying wolf, but above the ~11,700 a parser that ignored
 * untagged paths used to return, so that particular regression cannot come
 * back unnoticed.
 */
const MIN_PLAUSIBLE_ENTRIES = 14_000;

/** One save location, already translated into this project's own template. */
export interface ManifestSavePath {
  /** The literal directory part, e.g. `{appdata}\\Foo`. */
  pathTemplate: string;
  /** A glob for the remainder, or null when the whole path is a directory. */
  include: string | null;
}

export interface ManifestEntry {
  title: string;
  saves: ManifestSavePath[];
}

/**
 * Ludusavi's placeholders, mapped onto the tokens `saves.rs` understands.
 *
 * Anything not listed is either another platform's (`<xdgConfig>`) or names a
 * store's own root (`<root>`), neither of which this client can resolve — an
 * entry that needs one is dropped rather than guessed at.
 */
const PLACEHOLDERS: Record<string, string> = {
  '<base>': '{install}',
  '<game>': '{install}',
  '<home>': '{userprofile}',
  '<winAppData>': '{appdata}',
  // Upstream currently writes this one out as `<home>/AppData/LocalLow`, but
  // the placeholder is in their spec, so a switch to it should not silently
  // drop every Unity game that keeps its saves there. It has to be substituted
  // before `<winLocalAppData>`, which is a prefix of it.
  '<winLocalAppDataLow>': '{userprofile}/AppData/LocalLow',
  '<winLocalAppData>': '{localappdata}',
  '<winDocuments>': '{documents}',
  '<winPublic>': '{public}',
  '<winProgramData>': '{programdata}',
  '<winDir>': '{windir}',
};

/** Placeholders that stand for "whichever account", which a glob covers. */
const WILDCARD_PLACEHOLDERS = ['<storeUserId>', '<osUserName>'];

/** Placeholders this client cannot resolve; an entry using one is skipped. */
const UNSUPPORTED = ['<root>', '<xdgConfig>', '<xdgData>', '<xdgHome>'];

/**
 * Turns one manifest path into a rule this project can store.
 *
 * The client resolves `pathTemplate` to a literal directory and then walks it,
 * matching `include` against each relative path — so a wildcard anywhere in the
 * middle has to become part of the glob rather than part of the directory.
 * Returns null for anything that cannot be expressed that way.
 */
export function translatePath(raw: string): ManifestSavePath | null {
  if (UNSUPPORTED.some((token) => raw.includes(token))) return null;

  let translated = raw;
  // Longest first: `<winLocalAppData>` is a prefix of `<winLocalAppDataLow>`,
  // and substituting the short one first would leave a stray "Low>" behind.
  const tokens = Object.entries(PLACEHOLDERS).sort((a, b) => b[0].length - a[0].length);
  for (const [token, replacement] of tokens) {
    translated = translated.split(token).join(replacement);
  }
  for (const token of WILDCARD_PLACEHOLDERS) {
    translated = translated.split(token).join('*');
  }

  // An unrecognised placeholder would otherwise end up in a path as literal
  // text, producing a rule that silently never matches anything.
  if (/<[a-zA-Z]+>/.test(translated)) return null;
  if (!translated.startsWith('{')) return null;

  const segments = translated.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  const wildcardAt = segments.findIndex((segment, index) => index > 0 && /[*?[\]]/.test(segment));

  if (wildcardAt !== -1) {
    return {
      pathTemplate: segments.slice(0, wildcardAt).join('\\'),
      include: segments.slice(wildcardAt).join('/'),
    };
  }

  // No wildcard: a trailing segment with an extension is a file, and its
  // directory is what the rule should point at.
  const last = segments[segments.length - 1] ?? '';
  if (segments.length > 1 && /\.[A-Za-z0-9]{1,8}$/.test(last)) {
    return { pathTemplate: segments.slice(0, -1).join('\\'), include: last };
  }

  return { pathTemplate: segments.join('\\'), include: null };
}

/**
 * Reads the manifest without building it in memory.
 *
 * 17 MB of YAML becomes hundreds of megabytes as an object graph, which is a
 * lot to ask of a machine whose day job is serving files. The format is
 * regular — two-space indentation, quoted keys — so it is read a line at a
 * time and only the few fields that matter are kept.
 *
 * The shape being read, for one game:
 *
 * ```yaml
 * "Some Game":
 *   files:
 *     "<winAppData>/Some Game/Saves":
 *       tags:
 *         - save
 *       when:
 *         - os: windows
 *           store: steam
 * ```
 */
export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];

  let title: string | null = null;
  let saves: ManifestSavePath[] = [];

  let inFiles = false;
  let currentPath: string | null = null;
  /** Which key under the current path is being read: `tags:` or `when:`. */
  let field: 'tags' | 'when' | null = null;
  /** Whether the current path carried a `tags:` key at all. */
  let tagged = false;
  /** Whether those tags included `save`. */
  let taggedSave = false;
  /**
   * One entry per `when:` clause, holding that clause's `os:` or null for a
   * clause that names no operating system.
   */
  let whenClauses: Array<string | null> = [];

  const flushPath = () => {
    // An untagged path is save data. Upstream's own worked example spells this
    // out: `<base>/other`, carrying no tags, "will be backed up". Tags mark the
    // exception — a path that is *only* `config` is settings rather than a
    // save, and is the one thing left out here.
    const isSaveData = !tagged || taggedSave;

    // No `when:` means every platform, which includes Windows. A clause naming
    // only a store ("when: - store: steam") likewise constrains where the game
    // came from rather than which operating system it runs on.
    const onWindows =
      whenClauses.length === 0 || whenClauses.some((os) => os === null || os === 'windows');

    if (currentPath && isSaveData && onWindows) {
      const translated = translatePath(currentPath);
      // Two paths in one folder — `<base>/save.dat` and `<base>/slot2.dat` —
      // share a template and differ only in `include`, so both halves have to
      // match before one is dropped as a repeat.
      const duplicate = saves.some(
        (s) => s.pathTemplate === translated?.pathTemplate && s.include === translated?.include,
      );
      if (translated && !duplicate) saves.push(translated);
    }

    currentPath = null;
    field = null;
    tagged = false;
    taggedSave = false;
    whenClauses = [];
  };

  const flushGame = () => {
    flushPath();
    if (title && saves.length > 0) entries.push({ title, saves });
    title = null;
    saves = [];
    inFiles = false;
  };

  for (const line of text.split('\n')) {
    if (line.length === 0 || line === '---') continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      flushGame();
      title = readKey(content);
      continue;
    }
    if (!title) continue;

    // `files:`, `registry:`, `steam:` and the rest. Anything but `files:` ends
    // the run of paths that was being read.
    if (indent === 2) {
      flushPath();
      inFiles = content === 'files:';
      continue;
    }
    if (!inFiles) continue;

    if (indent === 4) {
      flushPath();
      currentPath = readKey(content);
      continue;
    }
    if (!currentPath) continue;

    if (indent === 6) {
      field = content === 'tags:' ? 'tags' : content === 'when:' ? 'when' : null;
      // Recorded on the key rather than on the items, so that a `tags:` block
      // listing only `config` still counts as "this path was tagged".
      if (field === 'tags') tagged = true;
      continue;
    }

    // Deeper than 6: an item of whichever key is open. A `when:` clause is a
    // list of maps, so `- os: windows` opens one and a plainer `store: epic`
    // on the next line still belongs to it.
    if (field === 'tags') {
      if (content === '- save') taggedSave = true;
      continue;
    }
    if (field === 'when') {
      if (content.startsWith('-')) {
        whenClauses.push(readOs(content.replace(/^-\s*/, '')));
      } else if (whenClauses.length > 0) {
        const os = readOs(content);
        if (os !== null) whenClauses[whenClauses.length - 1] = os;
      }
    }
  }
  flushGame();

  return entries;
}

/** Reads `"a key":` or `a key:` into the key itself, or null. */
function readKey(content: string): string | null {
  // A key whose value is an inline empty map — `"<path>": {}` — is the same as
  // one with nothing indented under it. Upstream does not write file paths that
  // way today, but it is ordinary YAML and costs one substitution to accept.
  const line = content.replace(/:\s*\{\s*\}$/, ':');

  const quoted = /^"((?:[^"\\]|\\.)*)":$/.exec(line);
  if (quoted) return unescapeKey(quoted[1] ?? '');
  const plain = /^(.+):$/.exec(line);
  return plain ? (plain[1] ?? '') : null;
}

/** `\"` and `\\` are the only escapes upstream's quoted keys use. */
function unescapeKey(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char: string) => char);
}

/** Reads the `os:` out of one `when:` clause line, or null if it names none. */
function readOs(content: string): string | null {
  const match = /^os:\s*"?([A-Za-z]+)"?$/.exec(content.trim());
  return match ? (match[1] ?? null) : null;
}

/** The cached index and when it was written. */
export interface ManifestStatus {
  games: number;
  fetchedAt: string | null;
  stale: boolean;
}

/**
 * Fetches, distils and caches the manifest.
 *
 * The distilled index is what is kept — titles and Windows save paths, a few
 * megabytes — rather than the original, so the expensive parse happens once per
 * refresh and never on a request.
 */
export class SaveManifestService {
  private cached: ManifestEntry[] | null = null;

  constructor(private readonly dataDir: string) {}

  private get indexPath(): string {
    return path.join(this.dataDir, 'save-manifest.json');
  }

  async status(): Promise<ManifestStatus> {
    const info = await stat(this.indexPath).catch(() => null);
    if (!info) return { games: 0, fetchedAt: null, stale: true };

    const entries = await this.load();
    const age = Date.now() - info.mtimeMs;
    return {
      games: entries.length,
      fetchedAt: new Date(info.mtimeMs).toISOString(),
      stale: age > MANIFEST_MAX_AGE_MS,
    };
  }

  async load(): Promise<ManifestEntry[]> {
    if (this.cached) return this.cached;
    const raw = await readFile(this.indexPath, 'utf8').catch(() => null);
    if (!raw) return [];
    try {
      this.cached = JSON.parse(raw) as ManifestEntry[];
    } catch {
      // A truncated cache is not worth a crash; the next refresh replaces it.
      this.cached = [];
    }
    return this.cached;
  }

  /**
   * Refreshes only when the cached index has aged past `MANIFEST_MAX_AGE_MS`.
   *
   * What the daily schedule calls. Deciding from the index's own mtime rather
   * than from a timer means a server that is restarted every day still pulls
   * once a day, and one that has been up for a month does not skip a month of
   * upstream changes because the interval never came round.
   *
   * Returns null when the index was already current and nothing was fetched.
   */
  async refreshIfStale(): Promise<ManifestStatus | null> {
    const current = await this.status();
    if (!current.stale) return null;
    return this.refresh();
  }

  /** Downloads and re-indexes. Returns how many games the index now holds. */
  async refresh(): Promise<ManifestStatus> {
    await mkdir(this.dataDir, { recursive: true });

    const response = await fetch(MANIFEST_URL, { headers: { Accept: 'text/yaml' } });
    if (!response.ok || !response.body) {
      throw new Error(`Could not fetch the save manifest (${response.status})`);
    }

    // Streamed to disk first: holding 17 MB and its parse in memory at once is
    // avoidable, and a half-finished download should not reach the parser.
    const download = path.join(this.dataDir, 'save-manifest.yaml.part');
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(download));

    // A connection dropped mid-download leaves valid YAML that simply stops
    // early, and the parser would read it happily and index whichever games
    // came alphabetically first. Comparing against the length upstream promised
    // is what tells the two apart.
    //
    // Only when the body arrived unencoded, though. `fetch` asks for gzip and
    // hands back the *decoded* stream, while `content-length` still describes
    // the compressed bytes — upstream sends 2 MB and 17 MB lands on disk, which
    // is not a truncated download but did read as one. A truncated gzip stream
    // fails to inflate, so that case is caught by the pipeline above instead.
    const encoded = (response.headers.get('content-encoding') ?? '').trim().length > 0;
    const expected = Number(response.headers.get('content-length'));
    const written = (await stat(download)).size;
    if (!encoded && Number.isFinite(expected) && expected > 0 && written !== expected) {
      throw new Error(
        `The save manifest download stopped early (${written} of ${expected} bytes). The existing index was kept.`,
      );
    }

    const text = await readFile(download, 'utf8');
    const entries = parseManifest(text);

    if (entries.length < MIN_PLAUSIBLE_ENTRIES) {
      throw new Error(
        `The save manifest parsed to only ${entries.length} games, which means its format changed. The existing index was kept.`,
      );
    }

    const staging = `${this.indexPath}.part`;
    await writeFile(staging, JSON.stringify(entries), 'utf8');
    await rename(staging, this.indexPath);
    this.cached = entries;

    return { games: entries.length, fetchedAt: new Date().toISOString(), stale: false };
  }
}

/**
 * Orders a game's save locations by how likely each is to be the one in use.
 *
 * A title can have several: a Microsoft Store build writes under `Packages`, a
 * storefront build writes to AppData, and a portable or repacked copy writes
 * inside its own folder. An archive of self-hosted builds is the last case far
 * more often than the first, so install-relative paths come first and Store
 * container paths come last. The operator still picks; this only decides which
 * one is offered first.
 */
export function rankSaves(saves: ManifestSavePath[]): ManifestSavePath[] {
  const score = (save: ManifestSavePath): number => {
    if (save.pathTemplate.startsWith('{install}')) return 0;
    if (save.pathTemplate.includes('\\Packages\\')) return 2;
    return 1;
  };
  return saves.slice().sort((a, b) => score(a) - score(b));
}

/** One catalog game matched against the manifest, for an operator to confirm. */
export interface SaveRuleSuggestion {
  gameId: string;
  /** The archive's title. */
  title: string;
  /** The manifest's title, shown beside it so a wrong match is obvious. */
  matchedTitle: string;
  /** Whether a save rule already exists, in which case this would replace it. */
  hasExistingRule: boolean;
  saves: ManifestSavePath[];
}

/**
 * Matches catalog titles against the manifest.
 *
 * On the normalised key the catalog already uses for its own matching, so
 * "Half-Life 2: Episode One" and "half life 2 episode one" land together. Only
 * exact key matches count — a fuzzy match across twenty thousand titles produces
 * confident nonsense, and this writes paths the client will later read and
 * write files at.
 */
export function matchCatalog(
  games: Array<{ id: string; title: string; hasRule: boolean }>,
  entries: ManifestEntry[],
): SaveRuleSuggestion[] {
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const key = matchKey(entry.title);
    // First writer wins: the manifest holds editions and re-releases under
    // separate titles that normalise alike, and the earlier one is no worse a
    // guess than the later.
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }

  // A library name often retains an edition marker that the manifest does
  // not ("Game - GOTY Edition"). Permit that only when it identifies one
  // manifest entry; a short title such as "Halo" must never guess at a sequel.
  const byBaseKey = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const key = baseTitleKey(entry.title);
    if (!key) continue;
    byBaseKey.set(key, [...(byBaseKey.get(key) ?? []), entry]);
  }

  const suggestions: SaveRuleSuggestion[] = [];
  for (const game of games) {
    const exact = byKey.get(matchKey(game.title));
    const variants = byBaseKey.get(baseTitleKey(game.title)) ?? [];
    const entry = exact ?? (variants.length === 1 ? variants[0] : undefined);
    if (!entry) continue;
    suggestions.push({
      gameId: game.id,
      title: game.title,
      matchedTitle: entry.title,
      hasExistingRule: game.hasRule,
      saves: rankSaves(entry.saves),
    });
  }
  return suggestions;
}

function baseTitleKey(title: string): string {
  return matchKey(
    title
      .replace(
        /\s*[-–—:]?\s*(?:game of the year|goty|complete|definitive|deluxe|gold|ultimate|enhanced|remastered|director'?s cut|collector'?s)\s*(?:edition)?$/i,
        '',
      )
      .replace(/\s*\([^)]*\)\s*$/, ''),
  );
}
