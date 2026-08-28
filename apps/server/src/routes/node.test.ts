import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

interface Session {
  cookie: string;
  csrf: string;
}

interface NodeStatus {
  libraries: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; libraryId: string; meshPort: number }>;
}

describe('Node management surface', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let firstLibrary: string;
  let secondLibrary: string;
  let session: Session;

  const auth = () => ({ cookie: session.cookie, [CSRF_HEADER]: session.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-node-test-'));
    firstLibrary = path.join(dataDir, 'library-one');
    secondLibrary = path.join(dataDir, 'library-two');
    await mkdir(firstLibrary);
    await mkdir(secondLibrary);

    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        ROLE: 'node',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        GAMEBLADE_NODE_BINARY: path.join(dataDir, 'deliberately-missing-node-agent'),
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'node-admin', password: 'a-long-enough-password' },
    });
    expect(setup.statusCode).toBe(201);
    const body = setup.json() as { csrfToken: string };
    const raw = setup.headers['set-cookie'];
    session = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
    };
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exposes the Node UI API but not Coordinator administration', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json()).toMatchObject({ role: 'node', needsSetup: false });

    const node = await app.inject({ method: 'GET', url: '/api/node/status', headers: auth() });
    expect(node.statusCode).toBe(200);

    const admin = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth() });
    expect(admin.statusCode).toBe(404);
  });

  it('manages multiple libraries and gives connections stable unique ports', async () => {
    for (const [name, libraryPath] of [
      ['Primary', firstLibrary],
      ['Archive', secondLibrary],
    ]) {
      const added = await app.inject({
        method: 'POST',
        url: '/api/node/libraries',
        headers: auth(),
        payload: { name, path: libraryPath, enabled: true },
      });
      expect(added.statusCode).toBe(201);
    }

    let status = (
      await app.inject({ method: 'GET', url: '/api/node/status', headers: auth() })
    ).json() as NodeStatus;
    expect(status.libraries).toHaveLength(2);

    for (const [index, library] of status.libraries.entries()) {
      const connected = await app.inject({
        method: 'POST',
        url: '/api/node/connections',
        headers: auth(),
        payload: {
          label: `Coordinator ${index + 1}`,
          coordinatorUrl: `https://coordinator-${index + 1}.example.com/`,
          libraryId: library.id,
          enrolmentToken: `enrolment-token-${index + 1}`,
        },
      });
      expect(connected.statusCode).toBe(201);
    }

    status = (
      await app.inject({ method: 'GET', url: '/api/node/status', headers: auth() })
    ).json() as NodeStatus;
    expect(status.connections.map((connection) => connection.meshPort)).toEqual([47_820, 47_821]);

    const first = status.connections[0]!;
    await app.inject({
      method: 'DELETE',
      url: `/api/node/connections/${first.id}`,
      headers: auth(),
    });

    const replacement = await app.inject({
      method: 'POST',
      url: '/api/node/connections',
      headers: auth(),
      payload: {
        label: 'Replacement Coordinator',
        coordinatorUrl: 'https://replacement.example.com',
        libraryId: status.libraries[0]!.id,
        enrolmentToken: 'replacement-enrolment-token',
      },
    });
    expect(replacement.statusCode).toBe(201);

    status = replacement.json() as NodeStatus;
    expect(new Set(status.connections.map((connection) => connection.meshPort)).size).toBe(2);
    expect(status.connections.map((connection) => connection.meshPort).sort()).toEqual([
      47_820, 47_821,
    ]);

    const enrolled = status.connections[0]!;
    const stateDir = path.join(dataDir, 'node-connections');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, `${enrolled.id}.json`),
      JSON.stringify({ nodeId: 'nod_enrolled', nodeToken: 'credential' }),
    );
    await app.inject({ method: 'GET', url: '/api/node/status', headers: auth() });

    const stored = JSON.parse(await readFile(path.join(dataDir, 'node-config.json'), 'utf8')) as {
      connections: Array<{ id: string; enrolmentToken?: string }>;
    };
    expect(stored.connections.find((connection) => connection.id === enrolled.id)).not.toHaveProperty(
      'enrolmentToken',
    );
  });
});
