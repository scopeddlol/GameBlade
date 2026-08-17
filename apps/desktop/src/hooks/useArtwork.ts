import { useEffect, useState } from 'react';
import { ipc } from '../lib/ipc.js';

/**
 * Cached across the whole app: the same cover appears on Home, Library and
 * Store, and each resolution is a round trip through the Rust side to have the
 * device token appended.
 */
const resolved = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function resolve(path: string): Promise<string> {
  const cached = resolved.get(path);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(path);
  if (existing) return existing;

  const pending = ipc
    .imageUrl(path)
    .then((url) => {
      resolved.set(path, url);
      inFlight.delete(path);
      return url;
    })
    .catch((error: unknown) => {
      inFlight.delete(path);
      throw error;
    });

  inFlight.set(path, pending);
  return pending;
}

/**
 * Turns a server-relative artwork path into a loadable URL.
 *
 * An `<img>` tag cannot send an Authorization header, so the device token has
 * to ride in the query string instead — which means every image URL has to be
 * built on the Rust side where the token lives.
 */
export function useArtwork(path: string | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (path ? resolved.get(path) : undefined));

  useEffect(() => {
    if (!path) {
      setUrl(undefined);
      return;
    }

    const cached = resolved.get(path);
    if (cached) {
      setUrl(cached);
      return;
    }

    let canceled = false;
    void resolve(path)
      .then((next) => {
        if (!canceled) setUrl(next);
      })
      .catch(() => {
        // Missing artwork is normal; the caller renders a placeholder.
        if (!canceled) setUrl(undefined);
      });

    return () => {
      canceled = true;
    };
  }, [path]);

  return url;
}
