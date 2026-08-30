import type { ReportedGame } from '@gameblade/shared';
import { describe, expect, it } from 'vitest';
import { splitCatalogBatches } from './catalogReporter.js';

function game(name: string): ReportedGame {
  return {
    relPath: name,
    kind: 'folder',
    sizeBytes: 1,
    contentMtime: '2026-01-01T00:00:00.000Z',
    files: [
      {
        relPath: `${name}-${'x'.repeat(180)}`,
        sizeBytes: 1,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('splitCatalogBatches', () => {
  it('keeps every game in order while bounding ordinary batches', () => {
    const games = ['One', 'Two', 'Three', 'Four'].map(game);
    const targetBytes = 500;
    const batches = splitCatalogBatches(games, targetBytes);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((entry) => entry.relPath)).toEqual(
      games.map((entry) => entry.relPath),
    );
    expect(batches.every((batch) => batch.length > 0)).toBe(true);
    expect(
      batches.every(
        (batch) =>
          batch.reduce(
            (bytes, entry, index) =>
              bytes + Buffer.byteLength(JSON.stringify(entry), 'utf8') + (index > 0 ? 1 : 0),
            0,
          ) <= targetBytes,
      ),
    ).toBe(true);
  });

  it('returns one complete empty batch so an empty library can clear old rows', () => {
    expect(splitCatalogBatches([])).toEqual([[]]);
  });

  it('keeps a single oversized game atomic', () => {
    const oversized = game('A game larger than the target by itself');
    expect(splitCatalogBatches([oversized], 1)).toEqual([[oversized]]);
  });
});
