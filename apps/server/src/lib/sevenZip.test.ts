import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listArchiveExecutables, sortCandidates } from './executables.js';
import { listSevenZipEntries, SevenZipError } from './sevenZip.js';

/*
 * The fixtures beside this file are real archives written by 7-Zip, because the
 * only interesting question here is whether GameBlade agrees with 7-Zip about
 * what is inside one. A hand-built byte sequence would only prove this reader
 * agrees with itself.
 *
 * All three hold the same tree — a small portable game plus three hundred tiny
 * stage files, so the header is large enough to be worth compressing — and
 * differ only in how that header is stored:
 *
 * * `game.7z` is what `7z a` writes by default: an LZMA-compressed header.
 * * `game-stored-header.7z` is `-mhc=off`, so the header is plain.
 * * `encrypted-header.7z` is `-mhe=on`, which no reader can list without the
 *   password.
 */
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const fixture = (name: string): string => path.join(fixtures, name);

describe('listSevenZipEntries', () => {
  it('reads an LZMA-compressed header', async () => {
    const entries = await listSevenZipEntries(fixture('game.7z'));

    expect(entries).toHaveLength(312);
    expect(entries).toContainEqual({
      path: 'Cave Story/bin/CaveStory.exe',
      sizeBytes: 9202,
      isDirectory: false,
    });
  });

  it('reads a stored header to exactly the same listing', async () => {
    const compressed = await listSevenZipEntries(fixture('game.7z'));
    const stored = await listSevenZipEntries(fixture('game-stored-header.7z'));

    expect(stored).toEqual(compressed);
  });

  it('tells directories, empty files and real files apart', async () => {
    const entries = await listSevenZipEntries(fixture('game.7z'));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    expect(byPath.get('Cave Story/empty folder')).toEqual({
      path: 'Cave Story/empty folder',
      sizeBytes: 0,
      isDirectory: true,
    });
    // A zero-byte file has no stream either, and only the header's second bit
    // vector tells it apart from the folder above.
    expect(byPath.get('Cave Story/data/placeholder.dat')).toEqual({
      path: 'Cave Story/data/placeholder.dat',
      sizeBytes: 0,
      isDirectory: false,
    });
    expect(byPath.get('Cave Story/readme.txt')?.sizeBytes).toBe(15);
  });

  it('keeps names outside ASCII intact', async () => {
    const entries = await listSevenZipEntries(fixture('game.7z'));

    expect(entries.map((entry) => entry.path)).toContain('Cave Story/Ünïcode Läuncher.exe');
  });

  it('sizes every entry the way the archive recorded it', async () => {
    const entries = await listSevenZipEntries(fixture('game.7z'));
    const stages = entries.filter((entry) => entry.path.includes('/stage/stage'));

    expect(stages).toHaveLength(300);
    // `stage 0\n` through `stage 299\n`: the sizes differ by digit count, so a
    // reader that lost its place in the size list could not produce these.
    expect(stages.filter((entry) => entry.sizeBytes === 8)).toHaveLength(10);
    expect(stages.filter((entry) => entry.sizeBytes === 9)).toHaveLength(90);
    expect(stages.filter((entry) => entry.sizeBytes === 10)).toHaveLength(200);
  });

  it('says so plainly when the header itself is encrypted', async () => {
    await expect(listSevenZipEntries(fixture('encrypted-header.7z'))).rejects.toThrow(
      SevenZipError,
    );
    await expect(listSevenZipEntries(fixture('encrypted-header.7z'))).rejects.toThrow(
      /encrypted header/i,
    );
  });

  it('refuses a file that is not an archive at all', async () => {
    await expect(listSevenZipEntries(fixture('../sevenZip.ts'))).rejects.toThrow(
      /not a 7z archive/i,
    );
  });
});

describe('listArchiveExecutables', () => {
  it('offers a 7z package’s game executables, largest first', async () => {
    const candidates = sortCandidates(await listArchiveExecutables(fixture('game.7z')));

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'Cave Story/bin/CaveStory.exe',
      'Cave Story/Ünïcode Läuncher.exe',
    ]);
  });

  it('leaves uninstallers and redistributables out, as it does for a ZIP', async () => {
    const candidates = await listArchiveExecutables(fixture('game.7z'));
    const paths = candidates.map((candidate) => candidate.path);

    expect(paths).not.toContain('Cave Story/bin/unins000.exe');
    expect(paths).not.toContain('Cave Story/redist/vcredist_x64.exe');
  });

  it('has nothing to say about a format it cannot open', async () => {
    await expect(listArchiveExecutables(fixture('game.rar'))).resolves.toEqual([]);
  });
});
