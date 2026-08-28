import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import type { Logger } from './metadata/service.js';

/** Runs the optional UDP fallback relay as part of the Coordinator lifecycle. */
export class RelayRuntime {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly publicKey: () => string,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.child || this.stopping || !this.config.relayEndpoint || this.config.role === 'node') {
      return;
    }

    const child = spawn(this.config.relayBinary, [], {
      env: {
        ...process.env,
        GAMEBLADE_COORDINATOR_KEY: this.publicKey(),
        GAMEBLADE_RELAY_PORT: String(this.config.relayPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (data: Buffer) =>
      this.logger.info({ component: 'relay' }, data.toString().trim()),
    );
    child.stderr.on('data', (data: Buffer) =>
      this.logger.warn({ component: 'relay' }, data.toString().trim()),
    );
    child.on('error', (error) => this.logger.error({ err: error }, 'could not start relay'));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.logger.warn({ code, signal }, 'relay exited; restarting');
      this.restartTimer = setTimeout(() => this.start(), 5_000);
      this.restartTimer.unref();
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
