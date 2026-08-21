import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Refreshed weekly; the upstream data changes slowly and is 17 MB a time. */
export const MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * A parse that finds fewer than this many games did not understand the file.
 *
 * Upstream is a third party who may change their format. Without a floor a
 * failed parse would quietly replace a good index with an empty one, and every
 * suggestion would silently stop appearing rather than reporting a problem.
 *
 * The real figure is around 11,600, so this leaves room for upstream to prune
 * without crying wolf while still catching a parse that understood nothing.
 */
const MIN_PLAUSIBLE_ENTRIES = 5_000;

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
  for (const [token, replacement] of Object.entries(PLACEHOLDERS)) {
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
 */
export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];

  let title: string | null = null;
  let saves: ManifestSavePath[] = [];
  let currentPath: string | null = null;
  let currentIsSave = false;
  let currentIsWindows = false;
  let seenWhen = false;
  let inFiles = false;

  const flushPath = () => {
    // `when` absent means every platform, which includes Windows.
    if (currentPath && currentIsSave && (currentIsWindows || !seenWhen)) {
      const translated = translatePath(currentPath);
      if (translated && !saves.some((s) => s.pathTemplate === translated.pathTemplate)) {
        saves.push(translated);
      }
    }
    currentPath = null;
    currentIsSave = false;
    currentIsWindows = false;
    seenWhen = false;
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
      const match = /^"((?:[^"\\]|\\.)*)":$/.exec(content) ?? /^([^:]+):$/.exec(content);
      if (match) title = (match[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      continue;
    }
    if (!title) continue;

    if (indent === 2) {
      flushPath();
      inFiles = content === 'files:';
      continue;
    }
    if (!inFiles) continue;

    if (indent === 4) {
      flushPath();
      const match = /^"((?:[^"\\]|\\.)*)":$/.exec(content) ?? /^(.+):$/.exec(content);
      if (match) currentPath = (match[1] ?? '').replace(/\\"/g, '"');
      continue;
    }

    if (content === '- save') currentIsSave = true;
    if (content === 'when:') seenWhen = true;
    if (content.includes('os: windows')) currentIsWindows = true;
  }
  flushGame();

  return entries;
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
