import { describe, expect, it } from 'vitest';
import { allowedMentions, extractMentions, mentionToken, pingLine } from './discordMentions.js';

describe('extractMentions', () => {
  it('finds each kind of token', () => {
    const found = extractMentions(
      '<@111111111111111111> <@&222222222222222222> <#333333333333333333>',
    );
    expect(found.users).toEqual(['111111111111111111']);
    expect(found.roles).toEqual(['222222222222222222']);
    expect(found.channels).toEqual(['333333333333333333']);
  });

  it('accepts the old nickname form some clients still write', () => {
    expect(extractMentions('<@!111111111111111111>').users).toEqual(['111111111111111111']);
  });

  it('reads a title and a body together', () => {
    const found = extractMentions('<@&222222222222222222>', 'hello <@111111111111111111>');
    expect(found.roles).toHaveLength(1);
    expect(found.users).toHaveLength(1);
  });

  it('de-duplicates, because this becomes a permission list', () => {
    const found = extractMentions('<@111111111111111111> and <@111111111111111111>');
    expect(found.users).toEqual(['111111111111111111']);
  });

  it('notices @everyone and @here', () => {
    expect(extractMentions('hello @everyone').everyone).toBe(true);
    expect(extractMentions('hello @here').everyone).toBe(true);
    expect(extractMentions('hello there').everyone).toBe(false);
  });

  it('ignores something merely shaped like a mention', () => {
    expect(extractMentions('<@12>').users).toEqual([]);
    expect(extractMentions('email@example.com').users).toEqual([]);
  });
});

/**
 * The permission list is an allow-list on purpose: omitting it tells Discord to
 * notify whatever it finds, which turns a stray `@everyone` in a provider's
 * game summary into a ping to the entire server.
 */
describe('allowedMentions', () => {
  it('names exactly the ids the text contained', () => {
    const allowed = allowedMentions(
      extractMentions('<@111111111111111111> <@&222222222222222222>'),
    );
    expect(allowed).toEqual({
      parse: [],
      users: ['111111111111111111'],
      roles: ['222222222222222222'],
    });
  });

  it('refuses @everyone unless it was asked for', () => {
    expect(allowedMentions(extractMentions('@everyone')).parse).toEqual([]);
    expect(allowedMentions(extractMentions('@everyone'), { allowEveryone: true }).parse).toEqual([
      'everyone',
    ]);
  });
});

/**
 * Discord never notifies for anything inside an embed, whatever the token
 * looks like. Repeating the mentions in the message content is the only way an
 * embed addressed to a role reaches that role.
 */
describe('pingLine', () => {
  it('repeats roles and users so an embed actually notifies', () => {
    const line = pingLine(extractMentions('<@&222222222222222222> <@111111111111111111>'));
    expect(line).toBe('<@&222222222222222222> <@111111111111111111>');
  });

  it('leaves channels out, since they never notify', () => {
    expect(pingLine(extractMentions('<#333333333333333333>'))).toBeNull();
  });

  it('says nothing when there is nothing to ping', () => {
    expect(pingLine(extractMentions('a plain announcement'))).toBeNull();
  });

  it('only says @everyone when that was allowed', () => {
    expect(pingLine(extractMentions('@everyone'))).toBeNull();
    expect(pingLine(extractMentions('@everyone'), { allowEveryone: true })).toBe('@everyone');
  });
});

describe('mentionToken', () => {
  it('writes each kind the way Discord reads it', () => {
    expect(mentionToken('user', '1')).toBe('<@1>');
    expect(mentionToken('role', '1')).toBe('<@&1>');
    expect(mentionToken('channel', '1')).toBe('<#1>');
  });
});
