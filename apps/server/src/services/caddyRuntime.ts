import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import type { Logger } from './metadata/service.js';

type CaddyProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Runs the Coordinator's bundled TLS reverse proxy under the same lifecycle. */
export class CaddyRuntime {
  private child: CaddyProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.caddyEnabled || this.config.role !== 'coordinator' || this.child) return;
    this.stopping = false;
    const child = spawn(
      this.config.caddyBinary,
      ['run', '--config', this.config.caddyConfigPath, '--adapter', 'caddyfile'],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    child.stdout.on('data', (data: Buffer) =>
      this.logger.info({ component: 'caddy' }, data.toString().trim()),
    );
    child.stderr.on('data', (data: Buffer) =>
      this.logger.info({ component: 'caddy' }, data.toString().trim()),
    );
    child.on('error', (error) => this.logger.error({ err: error }, 'could not start Caddy'));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.logger.warn({ code, signal }, 'Caddy exited; restarting');
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
