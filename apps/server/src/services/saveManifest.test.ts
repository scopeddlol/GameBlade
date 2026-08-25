import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_MAX_AGE_MS,
  SaveManifestService,
  matchCatalog,
  parseManifest,
  rankSaves,
  translatePath,
} from './saveManifest.js';

/**
 * Translating save paths from the upstream manifest.
 *
 * The client resolves a rule's `pathTemplate` to one literal directory and then
 * matches `include` against each relative path underneath it. So the whole job
 * here is splitting a single upstream path into those two halves correctly — a
 * wildcard left in the directory produces a rule that silently matches nothing.
 */
describe('translatePath', () => {
  it('maps a plain directory', () => {
    expect(translatePath('<winAppData>/StardewValley/Saves')).toEqual({
      pathTemplate: '{appdata}\\StardewValley\\Saves',
      include: null,
    });
  });

  it('splits a mid-path wildcard into the glob half', () => {
    // <storeUserId> is "whichever account", which only the glob can express.
    expect(translatePath('<winAppData>/Activision/QoS/players/<storeUserId>/config.cfg')).toEqual({
      pathTemplate: '{appdata}\\Activision\\QoS\\players',
      include: '*/config.cfg',
    });
  });

  it('treats a trailing filename as the include, not the directory', () => {
    expect(translatePath('<home>/Documents/game/save.dat')).toEqual({
      pathTemplate: '{userprofile}\\Documents\\game',
      include: 'save.dat',
    });
  });

  it('keeps an install-relative path relative', () => {
    // The case that matters for repacks and portable builds.
    expect(translatePath('<base>/Saves/*.celeste')).toEqual({
      pathTemplate: '{install}\\Saves',
      include: '*.celeste',
    });
  });

  it('refuses a path rooted at a store directory', () => {
    // <root> is Steam's own userdata folder; without Steam there is nothing to
    // resolve it to, and guessing would produce a rule pointing somewhere wrong.
    expect(translatePath('<root>/userdata/<storeUserId>/525480/remote/savedata')).toBeNull();
  });

  it('refuses another platform’s placeholders', () => {
    expect(translatePath('<xdgConfig>/foo')).toBeNull();
    expect(translatePath('<xdgData>/foo')).toBeNull();
  });

  it('refuses a hardcoded absolute path', () => {
    // Real entries contain these; they describe one machine, not a rule.
    expect(translatePath('C:/UDK/A Tribute To DKC/UDKGame/SaveData')).toBeNull();
  });

  it('refuses a placeholder it does not know', () => {
    // Upstream could add one. Passing it through would leave literal "<foo>"
    // in a stored path, which resolves to a directory that cannot exist.
    expect(translatePath('<somethingNew>/saves')).toBeNull();
  });

  it('does not mistake the LocalLow placeholder for its shorter prefix', () => {
    // `<winLocalAppData>` is a prefix of `<winLocalAppDataLow>`; substituting
    // the short one first would leave a stray "Low" in the middle of the path.
    expect(translatePath('<winLocalAppDataLow>/Studio/Game')).toEqual({
      pathTemplate: '{userprofile}\\AppData\\LocalLow\\Studio\\Game',
      include: null,
    });
  });
});

describe('parseManifest', () => {
  const sample = `---
"Test Game":
  files:
    "<winAppData>/TestGame/Saves":
      tags:
        - save
      when:
        - os: windows
    "<winAppData>/TestGame/Config":
      tags:
        - config
      when:
        - os: windows
  steam:
    id: 1
"Linux Only":
  files:
    "<xdgData>/linuxgame":
      tags:
        - save
      when:
        - os: linux
"Every Platform":
  files:
    "<home>/anywhere/saves":
      tags:
        - save
"No Files At All":
  steam:
    id: 2
"Untagged Path":
  files:
    "<winAppData>/Untagged/Saves":
      when:
        - os: windows
"Untagged Inline":
  files:
    "<winAppData>/Inline/Saves": {}
"Store Clause Only":
  files:
    "<home>/StoreOnly/save.dat":
      when:
        - store: steam
"Bit Before Os":
  files:
    "<winAppData>/BitFirst":
      tags:
        - save
      when:
        - bit: 64
          os: windows
"Config Only":
  files:
    "<winAppData>/ConfigOnly":
      tags:
        - config
"Two Files One Folder":
  files:
    "<base>/save.dat":
      tags:
        - save
    "<base>/slot2.dat":
      tags:
        - save
"Registry Only":
  registry:
    HKEY_CURRENT_USER/Software/Thing:
      tags:
        - save
`;

  it('leaves out a path tagged only as config', () => {
    const entries = parseManifest(sample);
    const game = entries.find((e) => e.title === 'Test Game');
    expect(game?.saves).toEqual([{ pathTemplate: '{appdata}\\TestGame\\Saves', include: null }]);
  });

  /**
   * The case that used to cost roughly 8,000 games.
   *
   * Upstream tags a path to mark an exception, not to opt it in: their own
   * worked example has `<base>/other` carrying no tags at all and says it
   * "will be backed up". Requiring a `save` tag threw away every such entry.
   */
  it('treats a path with no tags at all as save data', () => {
    const game = parseManifest(sample).find((e) => e.title === 'Untagged Path');
    expect(game?.saves).toEqual([{ pathTemplate: '{appdata}\\Untagged\\Saves', include: null }]);
  });

  it('accepts a path written with an inline empty map', () => {
    // `"<path>": {}` carries neither tags nor platform clause, so it is a save
    // on every platform.
    const game = parseManifest(sample).find((e) => e.title === 'Untagged Inline');
    expect(game?.saves).toEqual([{ pathTemplate: '{appdata}\\Inline\\Saves', include: null }]);
  });

  it('keeps a clause that names a store but no platform', () => {
    // "when: - store: steam" says where the game came from, not what it runs
    // on, so it does not rule Windows out.
    const game = parseManifest(sample).find((e) => e.title === 'Store Clause Only');
    expect(game?.saves).toEqual([
      { pathTemplate: '{userprofile}\\StoreOnly', include: 'save.dat' },
    ]);
  });

  it('finds the platform on a continuation line of the same clause', () => {
    // `- bit: 64` opens the clause and `os: windows` lands on the next line.
    const game = parseManifest(sample).find((e) => e.title === 'Bit Before Os');
    expect(game?.saves).toEqual([{ pathTemplate: '{appdata}\\BitFirst', include: null }]);
  });

  it('drops a game whose only path is config', () => {
    expect(parseManifest(sample).find((e) => e.title === 'Config Only')).toBeUndefined();
  });

  it('keeps two files in one folder as separate candidates', () => {
    // They share a pathTemplate and differ only in `include`; collapsing on
    // the template alone would silently hide the second save slot.
    const game = parseManifest(sample).find((e) => e.title === 'Two Files One Folder');
    expect(game?.saves).toEqual([
      { pathTemplate: '{install}', include: 'save.dat' },
      { pathTemplate: '{install}', include: 'slot2.dat' },
    ]);
  });

  it('skips a game that only saves to the registry', () => {
    // Nothing here is a file, so there is no rule the client could act on.
    expect(parseManifest(sample).find((e) => e.title === 'Registry Only')).toBeUndefined();
  });

  it('drops a game whose saves are another platform’s', () => {
    expect(parseManifest(sample).find((e) => e.title === 'Linux Only')).toBeUndefined();
  });

  it('keeps a path with no platform clause, which means all of them', () => {
    const game = parseManifest(sample).find((e) => e.title === 'Every Platform');
    expect(game?.saves[0]?.pathTemplate).toBe('{userprofile}\\anywhere\\saves');
  });

  it('skips a game with no file data', () => {
    expect(parseManifest(sample).find((e) => e.title === 'No Files At All')).toBeUndefined();
  });

  it('handles an empty document without throwing', () => {
    expect(parseManifest('')).toEqual([]);
    expect(parseManifest('---\n')).toEqual([]);
  });
});

describe('matchCatalog', () => {
  const entries = [
    {
      title: 'Half-Life 2: Episode One',
      saves: [{ pathTemplate: '{install}\\hl2', include: null }],
    },
    { title: 'Celeste', saves: [{ pathTemplate: '{install}\\Saves', include: '*.celeste' }] },
  ];

  it('matches on the normalised key, not the exact string', () => {
    const [hit] = matchCatalog(
      [{ id: 'g1', title: 'half life 2 episode one', hasRule: false }],
      entries,
    );
    expect(hit?.matchedTitle).toBe('Half-Life 2: Episode One');
  });

  it('reports the manifest title so a wrong match is visible', () => {
    const [hit] = matchCatalog([{ id: 'g1', title: 'CELESTE', hasRule: false }], entries);
    expect(hit).toMatchObject({ title: 'CELESTE', matchedTitle: 'Celeste' });
  });

  it('flags a game that already has a rule rather than hiding it', () => {
    // Replacing a rule an operator wrote by hand should be their decision.
    const [hit] = matchCatalog([{ id: 'g1', title: 'Celeste', hasRule: true }], entries);
    expect(hit?.hasExistingRule).toBe(true);
  });

  it('says nothing about a game the manifest does not know', () => {
    expect(
      matchCatalog([{ id: 'g1', title: 'Some Homebrew Thing', hasRule: false }], entries),
    ).toEqual([]);
  });

  it('does not match loosely across different games', () => {
    // "Halo" must not pick up "Halo Wars"; only exact normalised keys count.
    const halo = [{ title: 'Halo Wars', saves: [{ pathTemplate: '{install}', include: null }] }];
    expect(matchCatalog([{ id: 'g1', title: 'Halo', hasRule: false }], halo)).toEqual([]);
  });
});

describe('rankSaves', () => {
  it('offers an install-relative path first', () => {
    // The case that matters here: a repacked or portable build keeps its saves
    // in its own folder rather than where the storefront release put them.
    const ranked = rankSaves([
      { pathTemplate: '{appdata}\\Game', include: null },
      { pathTemplate: '{install}\\Saves', include: null },
    ]);
    expect(ranked[0]?.pathTemplate).toBe('{install}\\Saves');
  });

  it('leaves Microsoft Store container paths last', () => {
    const ranked = rankSaves([
      { pathTemplate: '{localappdata}\\Packages\\Pub.Game_abc\\SystemAppData\\wgs', include: null },
      { pathTemplate: '{appdata}\\Game', include: null },
    ]);
    expect(ranked[0]?.pathTemplate).toBe('{appdata}\\Game');
  });

  it('does not lose any candidate', () => {
    const saves = [
      { pathTemplate: '{localappdata}\\Packages\\x', include: null },
      { pathTemplate: '{install}\\a', include: null },
      { pathTemplate: '{documents}\\b', include: null },
    ];
    expect(rankSaves(saves)).toHaveLength(3);
  });
});

/**
 * The daily schedule's guard.
 *
 * `refreshIfStale` is what the hourly timer calls, so the thing worth pinning
 * down is that a fresh index costs nothing: without this, an hourly check would
 * pull 17 MB from upstream twenty-four times a day.
 */
describe('refreshIfStale', () => {
  it('does nothing while the cached index is current', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gb-manifest-'));
    const service = new SaveManifestService(dir);

    // A plausible index, written now — so its mtime is inside the max age.
    await writeFile(
      path.join(dir, 'save-manifest.json'),
      JSON.stringify([{ title: 'Celeste', saves: [{ pathTemplate: '{install}', include: null }] }]),
      'utf8',
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(service.refreshIfStale()).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an index older than the max age as stale', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gb-manifest-'));
    const indexPath = path.join(dir, 'save-manifest.json');
    await writeFile(indexPath, JSON.stringify([{ title: 'Celeste', saves: [] }]), 'utf8');

    // Backdate it past the ceiling; `status` reads the file's own mtime.
    const old = new Date(Date.now() - MANIFEST_MAX_AGE_MS - 60_000);
    await utimes(indexPath, old, old);

    const service = new SaveManifestService(dir);
    await expect(service.status()).resolves.toMatchObject({ stale: true });
    await rm(dir, { recursive: true, force: true });
  });
});
