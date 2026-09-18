import { describe, expect, it } from 'vitest';
import {
  PACKAGE_EXTENSIONS,
  PACKAGE_FORMATS,
  isInstallablePackage,
  isPackagedGame,
  packageFormatOf,
  stripPackageExtension,
} from './packages.js';

describe('packageFormatOf', () => {
  it('names the format a path is stored in', () => {
    expect(packageFormatOf('Cave Story.zip')).toBe('zip');
    expect(packageFormatOf('Cave Story.7z')).toBe('7z');
  });

  it('ignores case, because a library is full of .ZIP and .7Z', () => {
    expect(packageFormatOf('Game.ZIP')).toBe('zip');
    expect(packageFormatOf('Game.7Z')).toBe('7z');
  });

  it('refuses formats the client cannot unpack on its own', () => {
    expect(packageFormatOf('Game.rar')).toBeNull();
    expect(packageFormatOf('Game.tar.gz')).toBeNull();
    expect(packageFormatOf('Game.iso')).toBeNull();
  });

  it('is not fooled by a name that merely contains an extension', () => {
    expect(packageFormatOf('Game.7z.part')).toBeNull();
    expect(packageFormatOf('zip')).toBeNull();
  });

  it('keeps one extension per format, spelled the same way', () => {
    expect(PACKAGE_EXTENSIONS).toEqual(PACKAGE_FORMATS.map((format) => `.${format}`));
  });
});

describe('isPackagedGame', () => {
  it('accepts an archive game in a supported format', () => {
    expect(isPackagedGame({ kind: 'archive', relPath: 'Cave Story.7z' })).toBe(true);
  });

  it('rejects a folder game, whatever it is called', () => {
    // A directory named like an archive is still a directory, and the download
    // contract is one file per game.
    expect(isPackagedGame({ kind: 'folder', relPath: 'Cave Story.7z' })).toBe(false);
  });

  it('rejects an archive in a format the client cannot install', () => {
    expect(isPackagedGame({ kind: 'archive', relPath: 'Cave Story.rar' })).toBe(false);
  });
});

describe('stripPackageExtension', () => {
  it('drops a package extension and nothing else', () => {
    expect(stripPackageExtension('Cave Story.7z')).toBe('Cave Story');
    expect(stripPackageExtension('Cave Story.zip')).toBe('Cave Story');
    expect(stripPackageExtension('Cave Story.rar')).toBe('Cave Story.rar');
    expect(stripPackageExtension('Cave Story v1.2.zip')).toBe('Cave Story v1.2');
  });

  it('leaves a name with no extension alone', () => {
    expect(stripPackageExtension('Cave Story')).toBe('Cave Story');
  });
});

describe('isInstallablePackage', () => {
  it('agrees with packageFormatOf on every supported extension', () => {
    for (const extension of PACKAGE_EXTENSIONS) {
      expect(isInstallablePackage(`Some Game${extension}`)).toBe(true);
    }
    expect(isInstallablePackage('Some Game.tar.zst')).toBe(false);
  });
});
