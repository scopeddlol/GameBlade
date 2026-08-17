import { describe, expect, it } from 'vitest';
import { matchKey, parseTitle, toSearchTitle, toSortTitle } from './titles.js';

describe('parseTitle', () => {
  it('leaves a clean folder name alone', () => {
    expect(parseTitle('Hollow Knight', false)).toBe('Hollow Knight');
  });

  it('strips an archive extension', () => {
    expect(parseTitle('Celeste.zip', true)).toBe('Celeste');
    expect(parseTitle('Hades.tar.gz', true)).toBe('Hades');
  });

  it('strips version markers', () => {
    expect(parseTitle('Celeste v1.4.0.0.zip', true)).toBe('Celeste');
    expect(parseTitle('Stardew Valley v1.6.8', false)).toBe('Stardew Valley');
    expect(parseTitle('Terraria Build 12345', false)).toBe('Terraria');
  });

  it('strips bracketed tags and release-group noise', () => {
    expect(parseTitle('The Witcher 3 Wild Hunt [GOG] (2015)', false)).toBe(
      'The Witcher 3 Wild Hunt',
    );
    expect(parseTitle('Hades.v1.38290.Repack-FitGirl', false)).toBe('Hades');
  });

  it('treats dots as separators only when there are no spaces', () => {
    expect(parseTitle('Stardew_Valley_v1.6.8', false)).toBe('Stardew Valley');
    // A dotted acronym must survive intact.
    expect(parseTitle('S.T.A.L.K.E.R. Anomaly', false)).toBe('S.T.A.L.K.E.R. Anomaly');
  });

  it('never returns an empty title', () => {
    // A name made entirely of noise tokens still has to produce something.
    expect(parseTitle('repack', false)).toBe('repack');
  });
});

describe('toSortTitle', () => {
  it('drops a leading article and punctuation', () => {
    expect(toSortTitle('The Last of Us')).toBe('last of us');
    expect(toSortTitle('S.T.A.L.K.E.R.')).toBe('stalker');
  });
});

describe('toSearchTitle', () => {
  it('removes a trailing year', () => {
    expect(toSearchTitle('Doom 2016')).toBe('Doom');
    expect(toSearchTitle('Half-Life 2')).toBe('Half-Life 2');
  });
});

describe('matchKey', () => {
  it('normalizes punctuation and ampersands so equivalent titles collide', () => {
    expect(matchKey('Rick & Morty')).toBe(matchKey('Rick and Morty'));
    expect(matchKey('Half-Life: Alyx')).toBe(matchKey('Half Life Alyx'));
  });
});
