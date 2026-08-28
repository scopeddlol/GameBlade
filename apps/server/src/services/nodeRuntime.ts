import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { games, libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { CatalogReporter } from './catalogReporter.js';
import type { ChunkService } from './chunks.js';
import type { Logger } from './metadata/service.js';
import type { ScannerService } from './scanner.js';

type AgentProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface NodeConnectionConfig {
  id: string;
  label: string;
  coordinatorUrl: string;
  libraryId: string;
  meshPort: number;
  enrolmentToken?: string;
}

interface StoredNodeConfig {
  version?: 2;
  connections?: NodeConnectionConfig[];
  /** v0.6.0 prerelease shape, migrated on read. */
  coordinatorUrl?: string;
  enrolmentToken?: string;
}

interface AgentState {
  nodeId?: string;
  nodeToken?: string;
}

export interface NodeLibraryStatus {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  games: number;
  chunkedGames: number;
  lastScanAt: string | null;
  lastScanStatus: string | null;
}

export interface NodeConnectionStatus extends Omit<NodeConnectionConfig, 'enrolmentToken'> {
  enrolled: boolean;
  nodeId: string | null;
  agent: 'stopped' | 'starting' | 'running' | 'error';
  agentError: string | null;
}

export interface NodeStatus {
  configured: boolean;
  libraries: NodeLibraryStatus[];
  connections: NodeConnectionStatus[];
  syncRunning: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  scan: ReturnType<ScannerService['getProgress']>;
  chunks: ReturnType<ChunkService['getProgress']>;
}

/**
 * One physical Node may hold many libraries and publish them to many
 * Coordinators. Each Coordinator/library pairing gets a separate identity and
 * QUIC agent: its enrollment token, node credential and trust key can never be
 * overwritten by another Coordinator.
 */
export class NodeRuntime {
  private readonly children = new Map<string, AgentProcess>();
  private readonly agentStatus = new Map<string, NodeConnectionStatus['agent']>();
  private readonly agentErrors = new Map<string, string | null>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly intentionalStops = new Set<string>();
  private stopping = false;
  private syncPromise: Promise<void> | null = null;
  private lastSyncAt: string | null = null;
  private lastSyncError: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly scanner: ScannerService,
    private readonly chunks: ChunkService,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.config.role !== 'node') return;
    this.stopping = false;
    await this.ensureBootstrapConnection();
    await this.reconcileAgents();
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.children.clear();
    this.agentStatus.clear();
  }

  async addConnection(input: {
    label: string;
    coordinatorUrl: string;
    libraryId: string;
    enrolmentToken: string;
  }): Promise<NodeStatus> {
    const library = this.db.select().from(libraries).where(eq(libraries.id, input.libraryId)).get();
    if (!library) throw ApiError.notFound('Library not found');

    const stored = await this.readStoredConfig();
    const coordinatorUrl = normaliseCoordinatorUrl(input.coordinatorUrl);
    if (
      stored.connections.some(
        (entry) => entry.coordinatorUrl === coordinatorUrl && entry.libraryId === input.libraryId,
      )
    ) {
      throw ApiError.conflict('That library is already connected to this Coordinator');
    }

    const connection: NodeConnectionConfig = {
      id: newId('con'),
      label: input.label.trim(),
      coordinatorUrl,
      libraryId: input.libraryId,
      meshPort: firstAvailablePort(
        this.config.nodeMeshPort,
        new Set(stored.connections.map((entry) => entry.meshPort)),
      ),
      enrolmentToken: input.enrolmentToken.trim(),
    };
    await this.writeStoredConfig({ version: 2, connections: [...stored.connections, connection] });
    await this.startConnection(connection);
    return this.status();
  }

  async removeConnection(id: string): Promise<void> {
    const stored = await this.readStoredConfig();
    if (!stored.connections.some((entry) => entry.id === id)) {
      throw ApiError.notFound('Coordinator connection not found');
    }
    await this.writeStoredConfig({
      version: 2,
      connections: stored.connections.filter((entry) => entry.id !== id),
    });
    await this.stopConnection(id);
  }

  /** Restart the agents whose mounted library configuration changed. */
  async refreshLibrary(libraryId: string): Promise<void> {
    const stored = await this.readStoredConfig();
    const targets = stored.connections.filter((entry) => entry.libraryId === libraryId);
    for (const connection of targets) await this.stopConnection(connection.id);
    for (const connection of targets) await this.startConnection(connection);
  }

  async status(): Promise<NodeStatus> {
    const stored = await this.readStoredConfig();
    const allGames = this.db.select().from(games).where(isNull(games.missingAt)).all();
    const libraryRows = this.db.select().from(libraries).all();

    const libraryStatus: NodeLibraryStatus[] = libraryRows.map((library) => {
      const held = allGames.filter((game) => game.libraryId === library.id);
      return {
        id: library.id,
        name: library.name,
        path: library.path,
        enabled: library.enabled,
        games: held.length,
        chunkedGames: held.filter((game) => this.chunks.isGameChunked(game.id)).length,
        lastScanAt: library.lastScanAt,
        lastScanStatus: library.lastScanStatus,
      };
    });

    const connectionStates = await Promise.all(
      stored.connections.map(async (connection) => {
        const state = await this.readAgentState(connection);
        return {
          state,
          status: {
            id: connection.id,
            label: connection.label,
            coordinatorUrl: connection.coordinatorUrl,
            libraryId: connection.libraryId,
            meshPort: connection.meshPort,
            enrolled: Boolean(state.nodeId && state.nodeToken),
            nodeId: state.nodeId ?? null,
            agent: this.agentStatus.get(connection.id) ?? 'stopped',
            agentError: this.agentErrors.get(connection.id) ?? null,
          } satisfies NodeConnectionStatus,
        };
      }),
    );
    const connections = connectionStates.map((entry) => entry.status);

    // An enrollment code has no use after the agent receives its credentials.
    // Remove spent codes from persistent configuration instead of retaining a
    // secret that can never be used again.
    if (
      connectionStates.some(
        (entry, index) => entry.status.enrolled && stored.connections[index]?.enrolmentToken,
      )
    ) {
      await this.writeStoredConfig({
        version: 2,
        connections: stored.connections.map((connection, index) =>
          connectionStates[index]?.status.enrolled
            ? { ...connection, enrolmentToken: undefined }
            : connection,
        ),
      });
    }

    return {
      configured: libraryStatus.length > 0 && connections.length > 0,
      libraries: libraryStatus,
      connections,
      syncRunning: this.syncPromise !== null,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      scan: this.scanner.getProgress(),
      chunks: this.chunks.getProgress(),
    };
  }

  sync(libraryId?: string): Promise<void> {
    if (this.syncPromise) throw ApiError.conflict('A node sync is already running');
    if (libraryId && !this.db.select().from(libraries).where(eq(libraries.id, libraryId)).get()) {
      throw ApiError.notFound('Library not found');
    }

    this.syncPromise = this.runSync(libraryId)
      .catch((error: unknown) => {
        this.lastSyncError = error instanceof Error ? error.message : String(error);
        this.logger.error({ err: error }, 'node sync failed');
      })
      .finally(() => {
        this.lastSyncAt = new Date().toISOString();
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  async report(connectionId?: string): Promise<boolean> {
    const stored = await this.readStoredConfig();
    const targets = connectionId
      ? stored.connections.filter((entry) => entry.id === connectionId)
      : stored.connections;
    let complete = true;

    for (const connection of targets) {
      const reporter = new CatalogReporter(
        this.db,
        {
          coordinatorUrl: connection.coordinatorUrl,
          statePath: this.statePath(connection),
          libraryId: connection.libraryId,
        },
        this.logger,
      );
      if (!(await reporter.ensureRegistered()) || !(await reporter.report())) complete = false;
    }
    return complete;
  }

  private async runSync(libraryId?: string): Promise<void> {
    const targets = libraryId
      ? [libraryId]
      : this.db
          .select({ id: libraries.id })
          .from(libraries)
          .where(eq(libraries.enabled, true))
          .all()
          .map((row) => row.id);
    if (targets.length === 0) throw new Error('No enabled libraries are configured on this Node');

    await this.scanner.scan({ libraryId, fetchMetadata: false });

    for (const target of targets) {
      const localGames = this.db
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.libraryId, target), isNull(games.missingAt)))
        .all();
      for (const game of localGames) {
        if (!this.chunks.isGameChunked(game.id)) await this.chunks.start(game.id);
      }
    }

    const stored = await this.readStoredConfig();
    for (const connection of stored.connections.filter(
      (entry) => !libraryId || entry.libraryId === libraryId,
    )) {
      await this.report(connection.id);
    }
  }

  private async reconcileAgents(): Promise<void> {
    const stored = await this.readStoredConfig();
    const current = new Set(stored.connections.map((entry) => entry.id));
    for (const id of this.children.keys()) {
      if (!current.has(id)) await this.stopConnection(id);
    }
    for (const connection of stored.connections) {
      await this.startConnection(connection);
    }
  }

  private async startConnection(connection: NodeConnectionConfig): Promise<void> {
    if (this.children.has(connection.id) || this.stopping) return;
    const library = this.db
      .select()
      .from(libraries)
      .where(eq(libraries.id, connection.libraryId))
      .get();
    if (!library?.enabled) {
      this.agentStatus.set(connection.id, 'stopped');
      this.agentErrors.set(connection.id, library ? 'Library is disabled' : 'Library was removed');
      return;
    }

    this.agentStatus.set(connection.id, 'starting');
    this.agentErrors.set(connection.id, null);
    const child = spawn(this.config.nodeBinary, [], {
      env: {
        ...process.env,
        GAMEBLADE_SERVER: connection.coordinatorUrl,
        GAMEBLADE_LIBRARY: library.path,
        GAMEBLADE_STATE: this.statePath(connection),
        GAMEBLADE_PORT: String(connection.meshPort),
        ...(connection.enrolmentToken ? { GAMEBLADE_ENROLMENT: connection.enrolmentToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(connection.id, child);

    child.stdout.on('data', (data: Buffer) => {
      this.agentStatus.set(connection.id, 'running');
      this.logger.info(
        { component: 'node-agent', connection: connection.label },
        data.toString().trim(),
      );
    });
    child.stderr.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      this.agentErrors.set(connection.id, message);
      this.logger.warn({ component: 'node-agent', connection: connection.label }, message);
    });
    child.on('error', (error) => {
      this.agentStatus.set(connection.id, 'error');
      this.agentErrors.set(connection.id, error.message);
      this.logger.error({ err: error, connection: connection.label }, 'could not start node agent');
    });
    child.on('exit', (code, signal) => {
      if (this.children.get(connection.id) === child) this.children.delete(connection.id);
      if (this.stopping || this.intentionalStops.has(connection.id)) return;
      this.agentStatus.set(connection.id, code === 0 ? 'stopped' : 'error');
      this.agentErrors.set(connection.id, `Agent exited (${signal ?? code ?? 'unknown'})`);
      const timer = setTimeout(() => {
        this.restartTimers.delete(connection.id);
        void this.reconcileAgents();
      }, 5_000);
      timer.unref();
      this.restartTimers.set(connection.id, timer);
    });
  }

  private async stopConnection(id: string): Promise<void> {
    const timer = this.restartTimers.get(id);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(id);
    const child = this.children.get(id);
    this.children.delete(id);
    if (child) {
      this.intentionalStops.add(id);
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      this.intentionalStops.delete(id);
    }
    this.agentStatus.set(id, 'stopped');
  }

  private async ensureBootstrapConnection(): Promise<void> {
    const stored = await this.readStoredConfig();
    if (stored.connections.length > 0 || !this.config.coordinatorUrl) return;
    const library = this.db.select().from(libraries).where(eq(libraries.enabled, true)).get();
    if (!library) return;
    await this.writeStoredConfig({
      version: 2,
      connections: [
        {
          id: 'legacy',
          label: 'Primary Coordinator',
          coordinatorUrl: this.config.coordinatorUrl,
          libraryId: library.id,
          meshPort: this.config.nodeMeshPort,
          ...(this.config.enrolmentToken ? { enrolmentToken: this.config.enrolmentToken } : {}),
        },
      ],
    });
  }

  private async readStoredConfig(): Promise<{ version: 2; connections: NodeConnectionConfig[] }> {
    try {
      const raw = JSON.parse(
        await readFile(this.config.nodeConfigPath, 'utf8'),
      ) as StoredNodeConfig;
      if (Array.isArray(raw.connections)) {
        // Two passes, so a connection needing a replacement port cannot be
        // handed one that a later connection is legitimately keeping — which
        // is what a single pass does, since it only knows the ports it has
        // already walked past.
        const retained = new Set<number>();
        for (const entry of raw.connections) {
          if (isMeshPort(entry.meshPort)) retained.add(entry.meshPort);
        }

        const taken = new Set(retained);
        const kept = new Set<number>();
        let changed = false;
        const connections = raw.connections.map((entry) => {
          // A duplicate is kept by the first connection that claims it; the
          // rest are reassigned.
          if (isMeshPort(entry.meshPort) && !kept.has(entry.meshPort)) {
            kept.add(entry.meshPort);
            return { ...entry, meshPort: entry.meshPort };
          }
          const meshPort = firstAvailablePort(this.config.nodeMeshPort, taken);
          taken.add(meshPort);
          changed = true;
          return { ...entry, meshPort };
        });
        if (changed) await this.writeStoredConfig({ version: 2, connections });
        return { version: 2, connections };
      }

      // Migrate the short-lived single-Coordinator prerelease shape without
      // losing its already-enrolled state file.
      if (raw.coordinatorUrl) {
        const library = this.db.select().from(libraries).where(eq(libraries.enabled, true)).get();
        if (library) {
          return {
            version: 2,
            connections: [
              {
                id: 'legacy',
                label: 'Primary Coordinator',
                coordinatorUrl: raw.coordinatorUrl,
                libraryId: library.id,
                meshPort: this.config.nodeMeshPort,
                ...(raw.enrolmentToken ? { enrolmentToken: raw.enrolmentToken } : {}),
              },
            ],
          };
        }
      }
    } catch {
      // Missing or half-written state is a first run.
    }
    return { version: 2, connections: [] };
  }

  private async writeStoredConfig(value: { version: 2; connections: NodeConnectionConfig[] }) {
    await mkdir(path.dirname(this.config.nodeConfigPath), { recursive: true });
    const temporary = `${this.config.nodeConfigPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, this.config.nodeConfigPath);
  }

  private statePath(connection: NodeConnectionConfig): string {
    return connection.id === 'legacy'
      ? this.config.nodeStatePath
      : path.join(this.config.dataDir, 'node-connections', `${connection.id}.json`);
  }

  private async readAgentState(connection: NodeConnectionConfig): Promise<AgentState> {
    try {
      return JSON.parse(await readFile(this.statePath(connection), 'utf8')) as AgentState;
    } catch {
      return {};
    }
  }
}

export function normaliseCoordinatorUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw ApiError.badRequest('Enter a complete Coordinator URL, including http:// or https://');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest('The Coordinator URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw ApiError.badRequest('The Coordinator URL cannot contain credentials, a query, or a hash');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function isMeshPort(port: number | undefined): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535;
}

function firstAvailablePort(base: number, used: Set<number>): number {
  for (let port = base; port <= 65_535; port += 1) {
    if (!used.has(port)) return port;
  }
  throw ApiError.conflict('No mesh ports remain at or above the configured MESH_PORT');
}
