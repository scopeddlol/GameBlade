#!/usr/bin/env node
/**
 * Stamp one version across every manifest that carries one.
 *
 * Ten files, read by five different tools, all of which have to agree: the
 * five `package.json` files, the Tauri config that names the installer, the
 * desktop crate, the mesh crate, and both Cargo lockfiles that record the local
 * crates they contain. A release where they disagree is not a broken build —
 * it is an installer that reports the wrong version to the update check, which
 * is worse, because it ships.
 *
 * This lives under `.github/` on purpose. It is CI's, not a build script an
 * operator is expected to run: releases come from the Publish workflow and
 * nowhere else now.
 *
 *     node .github/scripts/set-version.mjs 0.6.2
 *     node .github/scripts/set-version.mjs 0.6.2 --check
 *
 * `--check` writes nothing and exits non-zero if anything disagrees, which is
 * what CI uses to refuse a tag whose manifests were never bumped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Files whose *first* `"version": "…"` is the thing being stamped. */
const JSON_MANIFESTS = [
  'package.json',
  'packages/shared/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
];

/** Cargo manifests, whose own `version` is the first one under `[package]`. */
const CARGO_MANIFESTS = ['apps/desktop/src-tauri/Cargo.toml', 'crates/gameblade-mesh/Cargo.toml'];

/**
 * Lockfiles record the workspace crate's version too.
 *
 * Cargo rewrites these itself on the next build, but a lockfile that disagrees
 * makes `--locked` fail — which is exactly what a release build should use.
 */
const CARGO_LOCKS = [
  { path: 'apps/desktop/src-tauri/Cargo.lock', crate: 'gameblade-desktop' },
  // The desktop consumes the local mesh crate by path, so its lockfile carries
  // that workspace version as well as its own.
  { path: 'apps/desktop/src-tauri/Cargo.lock', crate: 'gameblade-mesh' },
  { path: 'crates/gameblade-mesh/Cargo.lock', crate: 'gameblade-mesh' },
];

const version = process.argv[2];
const check = process.argv.includes('--check');

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: set-version.mjs <x.y.z> [--check]');
  process.exit(2);
}

let disagreed = 0;

/** Replace only the first match, and say whether anything moved. */
function stamp(relative, pattern, replacement) {
  const file = path.join(root, relative);
  const before = readFileSync(file, 'utf8');

  if (!pattern.test(before)) {
    console.error(`${relative}: no version field matched — the manifest's shape changed`);
    process.exit(1);
  }
  // `test` advances lastIndex on a global regex; these are not global, but
  // resetting is free and stops that being a trap for the next edit.
  pattern.lastIndex = 0;

  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.log(`  ${relative} already at ${version}`);
    return;
  }

  if (check) {
    console.error(`  ${relative} does not say ${version}`);
    disagreed += 1;
    return;
  }

  writeFileSync(file, after, 'utf8');
  console.log(`  ${relative} -> ${version}`);
}

console.log(check ? `Checking every manifest says ${version}:` : `Stamping ${version}:`);

for (const manifest of JSON_MANIFESTS) {
  stamp(manifest, /("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

for (const manifest of CARGO_MANIFESTS) {
  stamp(manifest, /^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
}

for (const lock of CARGO_LOCKS) {
  // Anchored to the crate's own [[package]] block: a lockfile holds a version
  // for every dependency, and a loose match would rewrite whichever came first.
  stamp(lock.path, new RegExp(`(name = "${lock.crate}"\\nversion = ")[^"]*(")`), `$1${version}$2`);
}

if (disagreed > 0) {
  console.error(
    `\n${disagreed} manifest(s) disagree with ${version}.` +
      `\nRun: node .github/scripts/set-version.mjs ${version}`,
  );
  process.exit(1);
}

console.log(check ? 'All manifests agree.' : 'Done.');
