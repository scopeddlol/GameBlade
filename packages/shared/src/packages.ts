/**
 * The archive formats a game may be *distributed* in.
 *
 * A library can hold a game in any of the formats `ARCHIVE_EXTENSIONS` lists —
 * that is what a scan recognises as "one file, one game". Only some of those,
 * though, are formats the whole delivery chain understands end to end: the
 * Coordinator has to be able to describe one as a single resumable package, and
 * the Desktop client has to be able to unpack it on its own, without asking the
 * player to install anything. That smaller set lives here.
 *
 * It is deliberately one list rather than a `.zip` check repeated in a dozen
 * places. Every one of those checks used to spell the same rule slightly
 * differently — a `like '%.zip'` in SQL, an `endsWith` in a route, a suffix
 * match in Rust — so adding a second format meant finding all of them, and
 * missing one meant a game that the store offered and the installer refused.
 */
export const PACKAGE_FORMATS = ['zip', '7z'] as const;

export type PackageFormat = (typeof PACKAGE_FORMATS)[number];

/** The file extension each format is stored with, lowercase and dotted. */
export const PACKAGE_EXTENSIONS = ['.zip', '.7z'] as const;

/** How each format is written when a human is going to read it. */
export const PACKAGE_FORMAT_LABELS: Record<PackageFormat, string> = {
  zip: 'ZIP',
  '7z': '7z',
};

/**
 * Which package format a path names, or `null` for anything else.
 *
 * Extension-only on purpose: the Coordinator routinely answers about files it
 * does not hold and cannot open — a node's copy, or a game whose bytes moved
 * to another machine — so the decision has to be one every part of the fleet
 * can reach from the catalog alone and agree on.
 */
export function packageFormatOf(relPath: string): PackageFormat | null {
  const lower = relPath.toLowerCase();
  for (const format of PACKAGE_FORMATS) {
    if (lower.endsWith(`.${format}`)) return format;
  }
  return null;
}

/** Whether this path is a package the client can download and unpack itself. */
export function isInstallablePackage(relPath: string): boolean {
  return packageFormatOf(relPath) !== null;
}

/**
 * Whether this catalog row is one installable package.
 *
 * `kind` matters as much as the extension: a folder game that happens to
 * contain a `.zip` is not a package, it is a directory of files, and the
 * download contract is one file per game.
 */
export function isPackagedGame(game: { kind: string; relPath: string }): boolean {
  return game.kind === 'archive' && isInstallablePackage(game.relPath);
}

/** Every supported extension, as `.zip or .7z`, for a sentence an operator reads. */
export const PACKAGE_EXTENSION_LIST = PACKAGE_EXTENSIONS.join(' or ');

/**
 * What to tell an operator whose game is not in a format the client can
 * install. Written once so the store, the manifest and the download route all
 * say the same thing rather than three near-misses of it.
 */
export const UNSUPPORTED_PACKAGE_NOTE =
  `Downloads use one fast, resumable package. Store this game as a ` +
  `${PACKAGE_EXTENSION_LIST} archive and rescan the Node.`;

/**
 * Strips a package extension from a file name, leaving everything else alone.
 *
 * Used where a name is compared rather than opened — duplicate detection, and
 * the title parser — so `Game.zip` and `Game.7z` reduce to the same stem.
 */
export function stripPackageExtension(name: string): string {
  const format = packageFormatOf(name);
  return format ? name.slice(0, -(format.length + 1)) : name;
}
