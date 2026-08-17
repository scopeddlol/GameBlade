import { describe, expect, it } from 'vitest';
import { isLikelyGameExecutable, sortCandidates } from './executables.js';

describe('isLikelyGameExecutable', () => {
  it('accepts an ordinary game binary', () => {
    expect(isLikelyGameExecutable('bin/CaveStory.exe')).toBe(true);
    expect(isLikelyGameExecutable('game.exe')).toBe(true);
  });

  it('rejects anything that is not an .exe', () => {
    expect(isLikelyGameExecutable('readme.txt')).toBe(false);
    expect(isLikelyGameExecutable('data.pak')).toBe(false);
  });

  it('rejects known installer and redistributable helpers', () => {
    expect(isLikelyGameExecutable('unins000.exe')).toBe(false);
    expect(isLikelyGameExecutable('Setup.exe')).toBe(false);
    expect(isLikelyGameExecutable('vcredist_x64.exe')).toBe(false);
    expect(isLikelyGameExecutable('dependencies/dxsetup.exe')).toBe(false);
  });

  it('is case-insensitive on both the extension and the blocked names', () => {
    expect(isLikelyGameExecutable('Game.EXE')).toBe(true);
    expect(isLikelyGameExecutable('UNINSTALL.EXE')).toBe(false);
  });
});

describe('sortCandidates', () => {
  it('orders largest first without mutating the input', () => {
    const input = [
      { path: 'small.exe', sizeBytes: 100 },
      { path: 'big.exe', sizeBytes: 900_000 },
      { path: 'medium.exe', sizeBytes: 5_000 },
    ];
    const sorted = sortCandidates(input);
    expect(sorted.map((c) => c.path)).toEqual(['big.exe', 'medium.exe', 'small.exe']);
    expect(input[0]?.path).toBe('small.exe');
  });
});
