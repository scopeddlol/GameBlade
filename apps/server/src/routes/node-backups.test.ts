import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

async function zipEntries(target: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(target, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Could not open backup'));
      const entries: string[] = [];
      zip.on('entry', (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('Coordinator backups retained by a Node', () => {
  it('creates, authenticates, transfers and manages a complete archive', async () => {
    const coordinatorDir = await mkdtemp(path.join(tmpdir(), 'gb-backup-coordinator-'));
    const nodeDir = await mkdtemp(path.join(tmpdir(), 'gb-backup-node-'));
    const coordinator = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: coordinatorDir,
        LOG_LEVEL: 'silent',
        ROLE: 'coordinator',
      } as NodeJS.ProcessEnv),
    );
    const coordinatorUrl = await coordinator.listen({ port: 0, host: '127.0.0.1' });

    let node: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      const setup = await coordinator.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'archivist', password: 'a-long-enough-password' },
      });
      const cookie = String(setup.headers['set-cookie']).split(';')[0];
      const csrf = (setup.json() as { csrfToken: string }).csrfToken;
      const enrolment = await coordinator.inject({
        method: 'POST',
        url: '/api/mesh/enrolments',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { label: 'Backup vault', role: 'origin' },
      });

      const { publicKey } = generateKeyPairSync('ed25519');
      const spki = publicKey.export({ format: 'der', type: 'spki' });
      const registered = await coordinator.inject({
        method: 'POST',
        url: '/api/mesh/register',
        payload: {
          enrolmentToken: (enrolment.json() as { token: string }).token,
          publicKey: Buffer.from(spki.subarray(12)).toString('base64url'),
          endpoints: [],
        },
      });
      const identity = registered.json() as { nodeId: string; nodeToken: string };

      await mkdir(path.join(coordinatorDir, 'saves', 'player'), { recursive: true });
      await writeFile(path.join(coordinatorDir, 'saves', 'player', 'slot.zip'), 'precious save');
      await mkdir(path.join(coordinatorDir, 'images'), { recursive: true });
      await writeFile(path.join(coordinatorDir, 'images', 'cover.webp'), 'cached artwork');
      await writeFile(path.join(coordinatorDir, 'operator-config.json'), '{"theme":"violet"}');
      await writeFile(
        path.join(nodeDir, 'node-state.json'),
        JSON.stringify({ ...identity, coordinatorUrl }),
      );

      node = await buildApp(
        loadConfig({
          NODE_ENV: 'test',
          DATA_DIR: nodeDir,
          LOG_LEVEL: 'silent',
          ROLE: 'node',
          SCAN_ON_START: 'false',
          SCAN_INTERVAL_MINUTES: '0',
        } as NodeJS.ProcessEnv),
      );
      await node.ready();

      const started = await node.inject({ method: 'POST', url: '/api/node/backups', payload: {} });
      expect(started.statusCode).toBe(202);
      await node.gameblade.nodeBackups.wait();

      const snapshot = await node.gameblade.nodeBackups.snapshot();
      expect(snapshot.progress.phase).toBe('complete');
      expect(snapshot.copies).toHaveLength(1);
      expect(snapshot.copies[0]?.complete).toBe(true);

      const stored = path.join(nodeDir, 'coordinator-backups', snapshot.copies[0]!.name);
      const entries = await zipEntries(stored);
      expect(entries).toContain('gameblade.db');
      expect(entries).toContain('saves/player/slot.zip');
      expect(entries).toContain('images/cover.webp');
      expect(entries).toContain('operator-config.json');

      const removed = await node.inject({
        method: 'DELETE',
        url: `/api/node/backups/${encodeURIComponent(snapshot.copies[0]!.name)}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(await node.gameblade.nodeBackups.list()).toHaveLength(0);
    } finally {
      if (node) await node.close();
      await coordinator.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(coordinatorDir, { recursive: true, force: true });
    }
  }, 30_000);
});
