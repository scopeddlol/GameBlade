/**
 * The last few errors the app hit, for attaching to a bug report.
 *
 * A ring buffer rather than anything persistent: this exists so a report can
 * carry the thing that actually went wrong, which a reporter would never think
 * to include and usually cannot find. It is read only when somebody chooses to
 * send a report, and it never leaves the machine otherwise.
 */
const MAX_ENTRIES = 25;

const entries: string[] = [];

function record(message: string): void {
  entries.push(`${new Date().toISOString()} ${message}`);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** What has gone wrong recently, oldest first. */
export function recentErrors(): string[] {
  return [...entries];
}

/**
 * Starts collecting.
 *
 * Wraps rather than replaces console.error, so anything already watching it —
 * the devtools, a future log file — still sees everything.
 */
export function startErrorLog(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    original(...args);
  };

  window.addEventListener('error', (event) => {
    record(`uncaught: ${event.message} (${event.filename}:${event.lineno})`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    record(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}
