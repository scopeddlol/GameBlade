import { describe, expect, it } from 'vitest';
import { compareVersions, isUpdateAvailable } from './version.js';

/**
 * The client compares what it is running against what the operator published.
 * Getting this wrong either nags every launch or never offers a real update,
 * and both look like the feature is broken.
 */
describe('compareVersions', () => {
  it('orders by each segment in turn', () => {
    expect(compareVersions('0.4.1', '0.4.0')).toBeGreaterThan(0);
    expect(compareVersions('0.4.0', '0.5.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('does not compare segments as text', () => {
    // The reason for parsing at all: "10" sorts before "9" as a string.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('sorts a pre-release below the release it leads to', () => {
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBeLessThan(0);
    expect(compareVersions('0.5.0', '0.5.0-rc.1')).toBeGreaterThan(0);
  });

  it('ignores a leading v and surrounding space', () => {
    expect(compareVersions('v0.4.1', ' 0.4.1 ')).toBe(0);
  });
});

describe('isUpdateAvailable', () => {
  it('offers an update only when the published build is newer', () => {
    expect(isUpdateAvailable('0.4.0', '0.5.0')).toBe(true);
    expect(isUpdateAvailable('0.5.0', '0.5.0')).toBe(false);
    expect(isUpdateAvailable('0.6.0', '0.5.0')).toBe(false);
  });

  it('stays quiet when either side is missing', () => {
    expect(isUpdateAvailable(null, '0.5.0')).toBe(false);
    expect(isUpdateAvailable('0.4.0', null)).toBe(false);
    expect(isUpdateAvailable('0.4.0', '')).toBe(false);
  });

  it('stays quiet on something that is not a version', () => {
    // The field is free text an operator types; "latest" must not read as an
    // upgrade, and must not throw on the way to deciding that.
    expect(isUpdateAvailable('0.4.0', 'latest')).toBe(false);
    expect(isUpdateAvailable('0.4.0', 'v')).toBe(false);
    expect(isUpdateAvailable('not-a-version', '0.5.0')).toBe(false);
  });
});
