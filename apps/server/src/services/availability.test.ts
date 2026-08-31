import { describe, expect, it } from 'vitest';
import { describeAvailability } from './catalog.js';
import type { Game } from '../db/schema.js';

/** A catalog row with only the fields the verdict actually reads. */
function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'gam_1',
    kind: 'archive',
    relPath: 'Game.zip',
    missingAt: null,
    ...overrides,
  } as Game;
}

describe('describeAvailability', () => {
  it('waits for the ZIP hash grid even when the server holds the file', () => {
    const verdict = describeAvailability(game(), { files: 1, unhashed: 1 }, null);
    expect(verdict.state).toBe('coming-soon');
    expect(verdict.note).toContain('1 of 1');
  });

  it('offers a fully hashed ZIP held by this server', () => {
    expect(describeAvailability(game(), { files: 1, unhashed: 0 }, null).state).toBe('ready');
  });

  it('keeps folder games in the catalog but never offers them as downloads', () => {
    const verdict = describeAvailability(
      game({ kind: 'folder', relPath: 'Open Folder' }),
      { files: 20, unhashed: 0 },
      null,
    );
    expect(verdict.state).toBe('coming-soon');
    expect(verdict.note).toContain('.zip');
  });

  it('holds back a game whose files have gone missing', () => {
    const verdict = describeAvailability(
      game({ missingAt: '2026-01-01T00:00:00.000Z' }),
      { files: 12, unhashed: 0 },
      new Set(['gam_1']),
    );
    expect(verdict.state).toBe('coming-soon');
    expect(verdict.note).toContain('not on the server');
  });

  it('holds back a catalog entry nothing has been indexed for', () => {
    expect(describeAvailability(game(), { files: 0, unhashed: 0 }, null).state).toBe('coming-soon');
  });

  it('holds back a part-hashed game where the bytes come from a node', () => {
    const verdict = describeAvailability(game(), { files: 10, unhashed: 3 }, new Set(['gam_1']));
    expect(verdict.state).toBe('coming-soon');
    // The count is the point: "still being prepared" alone says nothing about
    // whether it is minutes away or days.
    expect(verdict.note).toContain('3 of 10');
  });

  it('holds back a hashed game whose node is offline', () => {
    const verdict = describeAvailability(game(), { files: 10, unhashed: 0 }, new Set());
    expect(verdict.state).toBe('coming-soon');
    expect(verdict.note).toContain('offline');
  });

  it('offers a hashed game an online node is holding', () => {
    const verdict = describeAvailability(game(), { files: 10, unhashed: 0 }, new Set(['gam_1']));
    expect(verdict.state).toBe('ready');
  });
});
