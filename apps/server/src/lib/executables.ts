import { packageFormatOf } from '@gameblade/shared';
import yauzl from 'yauzl';
import { listSevenZipEntries } from './sevenZip.js';

/**
 * Mirrors the desktop client's own filter (`NON_GAME_EXECUTABLES` in
 * install.rs) so the admin picker never offers something the client would
 * refuse to launch anyway.
 */
const NON_GAME_EXECUTABLES = [
  'unins',
  'uninstall',
  'setup',
  'install',
  'vcredist',
  'dxsetup',
  'dotnetfx',
  'directx',
  'crashreport',
  'crashhandler',
  'launcher_config',
  'config',
  'settings',
  'readme',
];

export interface ExecutableCandidate {
  path: string;
  sizeBytes: number;
}

export function isLikelyGameExecutable(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith('.exe')) return false;
  const name = relPath.split(/[/\\]/).pop() ?? relPath;
  const stem = name.slice(0, -'.exe'.length).toLowerCase();
  return !NON_GAME_EXECUTABLES.some((blocked) => stem.includes(blocked));
}

/** Largest first — the game binary is almost always far larger than the helpers shipped beside it. */
export function sortCandidates(candidates: ExecutableCandidate[]): ExecutableCandidate[] {
  return [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Lists the `.exe` entries inside a game package without extracting anything.
 *
 * Both formats keep a table of contents — a ZIP's central directory, a 7z's
 * header — so the cost is proportional to the number of entries rather than to
 * the size of the archive. That is the whole point: this runs over a node's
 * entire library on a timer, and a hundred-gigabyte game has to cost the same
 * as a small one.
 *
 * Throws when the archive cannot be read. Every caller treats that as "offer
 * no candidates", because a network-mounted library goes away for a moment
 * often enough that a failure here must never fail the pass around it.
 */
export async function listArchiveExecutables(absolutePath: string): Promise<ExecutableCandidate[]> {
  switch (packageFormatOf(absolutePath)) {
    case 'zip':
      return listZipExecutables(absolutePath);
    case '7z':
      return listSevenZipExecutables(absolutePath);
    default:
      return [];
  }
}

/** Lists .exe entries in a zip's central directory without extracting anything. */
async function listZipExecutables(absolutePath: string): Promise<ExecutableCandidate[]> {
  const zipfile = await yauzl.openPromise(absolutePath, { lazyEntries: true, autoClose: true });
  const found: ExecutableCandidate[] = [];
  for await (const entry of zipfile.eachEntry()) {
    const isDirectory = entry.fileName.endsWith('/');
    if (!isDirectory && isLikelyGameExecutable(entry.fileName)) {
      found.push({ path: entry.fileName, sizeBytes: entry.uncompressedSize });
    }
  }
  return found;
}

/** The same, from a 7z's header. */
async function listSevenZipExecutables(absolutePath: string): Promise<ExecutableCandidate[]> {
  const entries = await listSevenZipEntries(absolutePath);
  return entries
    .filter((entry) => !entry.isDirectory && isLikelyGameExecutable(entry.path))
    .map((entry) => ({ path: entry.path, sizeBytes: entry.sizeBytes }));
}
