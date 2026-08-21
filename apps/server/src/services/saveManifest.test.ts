import { describe, expect, it } from 'vitest';
import { matchCatalog, parseManifest, rankSaves, translatePath } from './saveManifest.js';

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
`;

  it('keeps only paths tagged as saves', () => {
    const entries = parseManifest(sample);
    const game = entries.find((e) => e.title === 'Test Game');
    expect(game?.saves).toEqual([{ pathTemplate: '{appdata}\\TestGame\\Saves', include: null }]);
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
