import { describe, expect, it } from 'vitest';
import { parseManifest, translatePath } from './saveManifest.js';

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
