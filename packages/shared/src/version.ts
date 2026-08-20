/**
 * Comparing two client versions.
 *
 * The desktop client checks what the server is publishing against what it is
 * running, so this has to answer "is theirs newer than mine" without a
 * dependency and without ever throwing: the strings come from a settings field
 * an operator typed and from the app's own manifest, and a malformed one must
 * mean "no update", never a crash on launch.
 */

/** One version as comparable parts. Trailing junk is ignored, not rejected. */
function parse(value: string): { parts: number[]; pre: string } | null {
  const trimmed = value.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  const [core = '', ...rest] = trimmed.split(/[-+]/);
  const parts = core.split('.').map((piece) => Number.parseInt(piece, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;

  // A pre-release sorts *below* the release it leads to, per semver.
  return { parts, pre: rest.join('-') };
}

/**
 * Negative when `a` is older, zero when equal, positive when `a` is newer.
 * Unparseable input compares equal, so nothing is offered as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    // A missing segment is zero: 1.2 and 1.2.0 are the same release.
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Whether the client should offer an update.
 *
 * Only ever true when both versions are readable and the server's is strictly
 * newer: an operator who clears the field, or types something that is not a
 * version, gets silence rather than a prompt to install nothing.
 */
export function isUpdateAvailable(
  running: string | null | undefined,
  published: string | null | undefined,
): boolean {
  if (!running || !published) return false;
  if (!parse(running) || !parse(published)) return false;
  return compareVersions(published, running) > 0;
}
