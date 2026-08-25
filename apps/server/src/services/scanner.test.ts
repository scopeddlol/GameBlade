import { describe, expect, it, vi } from 'vitest';
import { ScannerService } from './scanner.js';
import type { Db } from '../db/index.js';
import type { Game } from '../db/schema.js';
import type { MetadataService } from './metadata/service.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * The scanner reaches the database through a long drizzle chain, and enrichment
 * is the only part of it these tests exercise. A stub that answers the one
 * query `runMatchPending` makes is enough, and keeps the test about progress
 * rather than about SQL.
 */
function stubDb(pending: Game[]): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    all: () => pending,
  };
  return { select: () => chain } as unknown as Db;
}

function stubMetadata(overrides: Partial<MetadataService> = {}): MetadataService {
  return {
    hasIgdb: true,
    hasSteamGridDb: false,
    enrich: async () => {},
    ...overrides,
  } as unknown as MetadataService;
}

const game = (id: string): Game => ({ id, title: id }) as Game;

/**
 * Enrichment started from the admin panel rather than by a scan.
 *
 * The bug this pins down: `matchPending` set the state to `matching` and left
 * it there. The admin UI reads that as a run still in flight, so the progress
 * readout sat on its final count — "25 / 25" — and every scan button stayed
 * disabled until the server was restarted.
 */
describe('matchPending on its own', () => {
  it('returns to idle when it finishes', async () => {
    const scanner = new ScannerService(
      stubDb([game('a'), game('b')]),
      stubMetadata(),
      silentLogger,
    );

    await scanner.matchPending();

    const progress = scanner.getProgress();
    expect(progress.state).toBe('idle');
    expect(progress.finishedAt).not.toBeNull();
  });

  it('reports itself finished rather than running', async () => {
    const scanner = new ScannerService(stubDb([game('a')]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    // `isRunning` gates the route; a run that never clears it locks out scans.
    expect(scanner.isRunning).toBe(false);
  });

  it('does not strand the state when a provider throws', async () => {
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({
        enrich: () => {
          throw new Error('provider exploded');
        },
      }),
      silentLogger,
    );

    await scanner.matchPending();

    // Per-game failures are caught and logged, so the run still completes.
    expect(scanner.getProgress().state).toBe('idle');
    expect(scanner.isRunning).toBe(false);
  });

  it('settles at idle with nothing pending', async () => {
    const scanner = new ScannerService(stubDb([]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    expect(scanner.getProgress().state).toBe('idle');
  });

  it('settles at idle when no provider is configured', async () => {
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({ hasIgdb: false, hasSteamGridDb: false }),
      silentLogger,
    );

    await scanner.matchPending();

    expect(scanner.getProgress().state).toBe('idle');
  });

  it('does not start a second run while one is in flight', async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({ enrich: () => blocked }),
      silentLogger,
    );

    const first = scanner.matchPending();
    const second = scanner.matchPending();
    expect(scanner.isRunning).toBe(true);
    // The in-flight run is handed back rather than a duplicate being queued.
    expect(second).toBe(first);

    release();
    await first;
    expect(scanner.getProgress().state).toBe('idle');
  });
});
