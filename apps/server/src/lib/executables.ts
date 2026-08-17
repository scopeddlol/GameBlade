import yauzl from 'yauzl';

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

/** Lists .exe entries in a zip's central directory without extracting anything. */
export async function listZipExecutables(absolutePath: string): Promise<ExecutableCandidate[]> {
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
