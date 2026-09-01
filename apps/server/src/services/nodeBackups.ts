import { open, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo } from './backups.js';

const LOCAL_KEEP = 7;
const FRESH_FOR_MS = 24 * 60 * 60_000;

interface NodeState {
  nodeId?: string;
  nodeToken?: string;
  coordinatorUrl?: string;
}

export interface NodeBackupConfig {
  dataDir: string;
  statePath: string;
  coordinatorUrl: string | null;
}

export interface NodeBackupProgress {
  running: boolean;
  phase: 'idle' | 'requesting' | 'downloading' | 'complete' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  fileName: string | null;
  bytesReceived: number;
  totalBytes: number | null;
  lastError: string | null;
  lastSuccessfulAt: string | null;
}

export interface NodeBackupSnapshot {
  copies: BackupInfo[];
  totalBytes: number;
  keep: number;
  progress: NodeBackupProgress;
}

interface Logger {
  info: (context: object, message: string) => void;
  warn: (context: object, message: string) => void;
}

const IDLE_PROGRESS: NodeBackupProgress = {
  running: false,
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  fileName: null,
  bytesReceived: 0,
  totalBytes: null,
  lastError: null,
  lastSuccessfulAt: null,
};

/**
 * Off-machine copies of the Coordinator's irreplaceable state.
 *
 * The Node always initiates the connection. That preserves the mesh's useful
 * deployment property — Nodes need no public listener — while the Coordinator
 * still authenticates the machine before it may request or read an archive.
 */
export class NodeBackupService {
  private progress: NodeBackupProgress = { ...IDLE_PROGRESS };
  private running: Promise<void> | null = null;

  constructor(
    private readonly config: NodeBackupConfig,
    private readonly logger: Logger,
  ) {}

  private get dir(): string {
    return path.join(this.config.dataDir, 'coordinator-backups');
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  async snapshot(): Promise<NodeBackupSnapshot> {
    const copies = await this.list();
    const progress = { ...this.progress, running: this.isRunning };
    // The in-memory timestamp is naturally lost on restart; the newest durable
    // copy is the authoritative success record after that.
    if (!progress.lastSuccessfulAt && copies[0]) progress.lastSuccessfulAt = copies[0].createdAt;
    return {
      copies,
      totalBytes: copies.reduce((total, copy) => total + copy.sizeBytes, 0),
      keep: LOCAL_KEEP,
      progress,
    };
  }

  async list(): Promise<BackupInfo[]> {
    const entries = await readdir(this.dir).catch(() => []);
    const copies: BackupInfo[] = [];

    for (const name of entries) {
      const target = this.pathFor(name);
      if (!target) continue;
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) continue;
      copies.push({
        name,
        sizeBytes: info.size,
        createdAt: new Date(info.mtimeMs).toISOString(),
        complete: true,
      });
    }

    return copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pathFor(name: string): string | null {
    if (!/^gameblade-full-[\w.-]+\.zip$/.test(name) || name.includes('/') || name.includes('\\')) {
      return null;
    }
    return path.join(this.dir, name);
  }

  async remove(name: string): Promise<boolean> {
    const target = this.pathFor(name);
    if (!target) return false;
    await rm(target, { force: true });
    return true;
  }

  /** Start a pull without making an HTTP request wait for a large archive. */
  start(force: boolean): boolean {
    if (this.running) return false;

    const lastSuccessfulAt = this.progress.lastSuccessfulAt;
    this.progress = {
      ...IDLE_PROGRESS,
      running: true,
      phase: 'requesting',
      startedAt: new Date().toISOString(),
      lastSuccessfulAt,
    };

    this.running = this.pull(force)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.progress = {
          ...this.progress,
          running: false,
          phase: 'error',
          finishedAt: new Date().toISOString(),
          lastError: message,
        };
        this.logger.warn({ err: error }, 'could not store the Coordinator backup on this Node');
      })
      .finally(() => {
        this.running = null;
      });

    return true;
  }

  /** Exposed for tests and orderly callers that need to await the transfer. */
  async wait(): Promise<void> {
    await this.running;
  }

  private async pull(force: boolean): Promise<void> {
    const connection = await this.connection();
    const headers = {
      authorization: `Bearer ${connection.nodeToken}`,
      'x-gameblade-node': connection.nodeId,
    };

    let remote = await this.remoteList(connection.url, headers);
    let wanted = remote.find((copy) => copy.complete);

    const isFresh = wanted && Date.now() - Date.parse(wanted.createdAt) < FRESH_FOR_MS;
    if (force || !isFresh) {
      const response = await fetch(`${connection.url}/api/mesh/backups`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok)
        throw await responseError(response, 'Coordinator could not create a backup');
      wanted = (await response.json()) as BackupInfo;
      remote = [wanted, ...remote.filter((copy) => copy.name !== wanted?.name)];
    }

    if (!wanted?.complete || !this.pathFor(wanted.name)) {
      throw new Error('The Coordinator did not offer a complete backup');
    }

    const existing = await stat(this.pathFor(wanted.name)!).catch(() => null);
    if (!existing?.isFile() || existing.size !== wanted.sizeBytes) {
      await this.download(connection.url, headers, wanted);
    }

    await this.prune();
    this.progress = {
      ...this.progress,
      running: false,
      phase: 'complete',
      finishedAt: new Date().toISOString(),
      fileName: wanted.name,
      bytesReceived: wanted.sizeBytes,
      totalBytes: wanted.sizeBytes,
      lastError: null,
      lastSuccessfulAt: new Date().toISOString(),
    };
    this.logger.info({ backup: wanted.name, bytes: wanted.sizeBytes }, 'Coordinator backup stored');
  }

  private async remoteList(
    coordinatorUrl: string,
    headers: Record<string, string>,
  ): Promise<BackupInfo[]> {
    const response = await fetch(`${coordinatorUrl}/api/mesh/backups`, { headers });
    if (!response.ok) throw await responseError(response, 'Could not list Coordinator backups');
    const body = (await response.json()) as { backups?: BackupInfo[] };
    return (body.backups ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async download(
    coordinatorUrl: string,
    headers: Record<string, string>,
    backup: BackupInfo,
  ): Promise<void> {
    const target = this.pathFor(backup.name)!;
    const staging = `${target}.part`;
    await mkdir(this.dir, { recursive: true });
    await rm(staging, { force: true });

    const response = await fetch(
      `${coordinatorUrl}/api/mesh/backups/${encodeURIComponent(backup.name)}`,
      { headers },
    );
    if (!response.ok || !response.body) {
      throw await responseError(response, 'Could not download the Coordinator backup');
    }

    const declared = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(declared) && declared >= 0 ? declared : backup.sizeBytes;
    this.progress = {
      ...this.progress,
      phase: 'downloading',
      fileName: backup.name,
      bytesReceived: 0,
      totalBytes,
    };

    const handle = await open(staging, 'w');
    let received = 0;
    try {
      for await (const piece of response.body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(piece);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          if (bytesWritten <= 0) throw new Error('The backup file stopped accepting bytes');
          offset += bytesWritten;
        }
        received += bytes.length;
        this.progress = { ...this.progress, bytesReceived: received };
      }
    } finally {
      await handle.close();
    }

    if (received !== backup.sizeBytes) {
      await rm(staging, { force: true });
      throw new Error(`Backup transfer ended at ${received} of ${backup.sizeBytes} bytes`);
    }

    await rename(staging, target);
  }

  private async prune(): Promise<void> {
    const copies = await this.list();
    for (const copy of copies.slice(LOCAL_KEEP)) {
      await this.remove(copy.name);
    }
  }

  private async connection(): Promise<{ url: string; nodeId: string; nodeToken: string }> {
    let state: NodeState = {};
    try {
      state = JSON.parse(await readFile(this.config.statePath, 'utf8')) as NodeState;
    } catch {
      // The message below explains the actionable state.
    }

    const url = (this.config.coordinatorUrl ?? state.coordinatorUrl)?.replace(/\/+$/, '');
    if (!url || !state.nodeId || !state.nodeToken) {
      throw new Error('This Node must finish enrolling before it can store Coordinator backups');
    }
    return { url, nodeId: state.nodeId, nodeToken: state.nodeToken };
  }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return new Error(body.error?.message || `${fallback} (${response.status})`);
}
