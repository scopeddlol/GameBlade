import { Transform, type TransformCallback } from 'node:stream';

/** Below this a limit is not a limit, it is a stall. */
const MIN_BYTES_PER_SECOND = 1024;

/**
 * Paces a stream to a byte budget per second.
 *
 * Implemented by delaying the transform callback rather than by pausing the
 * source: backpressure then propagates naturally to whatever is producing the
 * bytes — a file read here — so the throttle costs one timer per chunk instead
 * of buffering the difference in memory.
 *
 * The budget is tracked over a sliding one-second window rather than as a
 * fixed tick, which keeps a burst at the start of a second from being paid for
 * twice.
 */
export function createThrottle(bytesPerSecond: number): Transform {
  const limit = Math.max(MIN_BYTES_PER_SECOND, Math.floor(bytesPerSecond));

  let windowStart = Date.now();
  let sentInWindow = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const now = Date.now();
      const elapsed = now - windowStart;

      if (elapsed >= 1000) {
        windowStart = now;
        sentInWindow = 0;
      }

      sentInWindow += chunk.length;
      this.push(chunk);

      if (sentInWindow < limit) {
        callback();
        return;
      }

      // Over budget: wait out the rest of this window before accepting more.
      // A chunk larger than the whole budget waits proportionally longer, so a
      // 1 MB chunk against a 100 KB/s limit pauses ten seconds rather than one.
      const owed = Math.ceil((sentInWindow / limit) * 1000) - (Date.now() - windowStart);
      if (owed <= 0) {
        callback();
        return;
      }

      const timer = setTimeout(() => {
        windowStart = Date.now();
        sentInWindow = 0;
        callback();
      }, owed);
      // A pending throttle must never be the reason the process stays alive.
      timer.unref?.();
    },
  });
}
