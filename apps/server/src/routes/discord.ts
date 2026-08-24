import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@gameblade/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { ApiError } from '../lib/errors.js';

/** Honor `X-Forwarded-Proto` when it is trusted, so cookies get Secure behind TLS. */
function isSecureRequest(request: FastifyRequest): boolean {
  const configured = request.server.gameblade.config.secureCookies;
  if (configured !== 'auto') return configured;
  return request.protocol === 'https';
}

/**
 * How long a started OAuth round trip stays valid.
 *
 * Long enough to read Discord's consent screen and pick an account, short
 * enough that a state cookie left on a shared machine is not a standing
 * invitation to attach an account to it.
 */
const STATE_TTL_SECONDS = 10 * 60;

const STATE_COOKIE = 'gb_discord_state';
/** Whether the round trip was started to link, or to sign in. */
const INTENT_COOKIE = 'gb_discord_intent';

type Intent = 'link' | 'signin';

/**
 * Linking a Discord account, and using one to get in.
 *
 * The whole flow is a redirect out and a redirect back, so the state has to
 * survive in a cookie rather than in memory — the callback may land on a
 * different worker, and the server may have restarted in between.
 *
 * On the way back the code is exchanged, the account identified, and guild
 * membership settled *before* anything is written: an operator who requires
 * players to be in their Discord means it, and a link recorded first and
 * checked second is a link that would survive the check failing.
 */
export async function discordRoutes(app: FastifyInstance): Promise<void> {
  const { discord, auth, settings, config } = app.gameblade;

  /** Where Discord sends the browser back. Must match the application's setting. */
  const redirectUri = (request: FastifyRequest): string => {
    const proto = request.protocol;
    const host = request.headers.host ?? 'localhost';
    return `${proto}://${host}${config.basePath}/api/auth/discord/callback`;
  };

  const setStateCookies = (reply: FastifyReply, state: string, intent: Intent) => {
    const options = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: config.isProduction,
      path: `${config.basePath || ''}/api/auth/discord`,
      maxAge: STATE_TTL_SECONDS,
    };
    reply.setCookie(STATE_COOKIE, state, options);
    reply.setCookie(INTENT_COOKIE, intent, options);
  };

  /** What the client needs to decide whether to offer any of this. */
  app.get('/auth/discord/status', async () => discord.status());

  /**
   * Starts the round trip.
   *
   * Answers with a URL rather than redirecting, because the caller is a fetch
   * from the web app or the desktop client — neither of which can follow a
   * redirect to a consent screen usefully. They open it themselves.
   */
  app.get('/auth/discord/start', async (request, reply) => {
    const { intent } = request.query as { intent?: string };
    const chosen: Intent = intent === 'signin' ? 'signin' : 'link';

    // Linking attaches to *this* account, so it needs one; signing in does not.
    if (chosen === 'link') requireUser(request);
    if (!discord.isConfigured) {
      throw ApiError.badRequest('Discord sign-in is not set up on this server');
    }

    const state = randomBytes(24).toString('base64url');
    setStateCookies(reply, state, chosen);
    return { url: discord.authorizeUrl(state, redirectUri(request)) };
  });

  /**
   * Where Discord returns.
   *
   * This is opened in a browser, so it answers with a small HTML page rather
   * than JSON: it either closes itself (when the desktop client opened it) or
   * sends the visitor back into the web app.
   */
  app.get('/auth/discord/callback', async (request, reply) => {
    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    const expected = request.cookies[STATE_COOKIE];
    const intent = (request.cookies[INTENT_COOKIE] ?? 'link') as Intent;
    reply.clearCookie(STATE_COOKIE, { path: `${config.basePath || ''}/api/auth/discord` });
    reply.clearCookie(INTENT_COOKIE, { path: `${config.basePath || ''}/api/auth/discord` });

    if (error) return finished(reply, false, 'Discord sign-in was cancelled.');
    if (!code || !state) return finished(reply, false, 'Discord sent an incomplete response.');

    // Without this, a code obtained anywhere could be replayed against
    // somebody else's session, attaching an attacker's Discord to their account.
    if (!expected || expected !== state) {
      return finished(reply, false, 'That sign-in attempt has expired. Try again.');
    }

    const tokens = await discord.exchangeCode(code, redirectUri(request));
    const identity = await discord.identify(tokens.access_token);

    /* -------------------------------------------------- guild membership */

    const { discordRequireGuild, discordInviteUrl } = settings.get();
    let inGuild = await discord.isInGuild(tokens.access_token);

    // Being told to go and join a Discord is a step people do not take, which
    // is the whole reason the join scope is requested.
    if (!inGuild) {
      const added = await discord.addToGuild(identity.id, tokens.access_token);
      if (added) inGuild = true;
    }

    if (!inGuild && discordRequireGuild) {
      return finished(
        reply,
        false,
        discordInviteUrl
          ? `Join the Discord first, then link again: ${discordInviteUrl}`
          : 'This server requires you to be in its Discord, and no invite has been published yet. Ask the operator.',
      );
    }

    /* ------------------------------------------------------------- signin */

    if (intent === 'signin') {
      const userId = discord.userIdFor(identity.id);
      if (!userId) {
        // Deliberately not creating an account here. The server is invite-only,
        // and a sign-in route that mints accounts is a way around that.
        return finished(
          reply,
          false,
          'That Discord account is not linked to anyone here. Sign in normally once, then link it from your account page.',
        );
      }

      const account = auth.findById(userId);
      if (!account || !account.isActive) {
        return finished(reply, false, 'That account is no longer active.');
      }

      // Refresh what Discord told us, then start a session — the same kind
      // the password path issues, so everything downstream is unchanged.
      discord.link(userId, identity, tokens, inGuild);
      const session = auth.createSession(userId, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...app.gameblade.cookieOptions(isSecureRequest(request)),
        expires: new Date(session.expiresAt),
      });
      return finished(reply, true, 'Signed in.');
    }

    /* --------------------------------------------------------------- link */

    const context = request.auth;
    if (!context) {
      return finished(reply, false, 'Your session expired while Discord was open. Try again.');
    }

    discord.link(context.user.id, identity, tokens, inGuild);
    return finished(reply, true, `Linked as ${identity.username}.`);
  });

  /* ------------------------------------------------------------- account */

  app.get('/account/discord', async (request) => {
    const context = requireUser(request);
    return { link: discord.forUser(context.user.id), status: discord.status() };
  });

  app.delete('/account/discord', async (request) => {
    const context = requireUser(request);
    discord.unlink(context.user.id);
    return { ok: true };
  });

  /** The show-my-handle toggle. Off unless somebody turns it on. */
  app.patch('/account/discord', async (request) => {
    const context = requireUser(request);
    const { showUsername } = (request.body ?? {}) as { showUsername?: boolean };
    if (typeof showUsername !== 'boolean') {
      throw ApiError.badRequest('showUsername must be true or false');
    }
    return { link: discord.setVisibility(context.user.id, showUsername) };
  });

  /**
   * People here you share the Discord with.
   *
   * Not a friends list: Discord publishes none to applications. This is the
   * closest the platform allows, and since linking pushes everyone into the
   * one server it is very nearly the same set.
   */
  app.get('/account/discord/neighbours', async (request) => {
    const context = requireUser(request);
    return { neighbours: discord.neighbours(context.user.id) };
  });
}

/**
 * The page the browser lands on at the end of the round trip.
 *
 * Plain HTML with no scripts of consequence: it closes itself when the desktop
 * client opened it in a popup, and otherwise says what happened. Text is
 * escaped — the message can carry an invite URL an operator typed.
 */
function finished(reply: FastifyReply, ok: boolean, message: string) {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${ok ? 'Linked' : 'Not linked'}</title>
<style>
  body { background:#0b0d12; color:#e2e6ee; font-family:system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  main { max-width:28rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; color:${ok ? '#34d399' : '#f87171'}; }
  p { color:#8a93a6; line-height:1.6; margin:0; }
</style></head>
<body><main>
  <h1>${ok ? 'Discord connected' : 'Could not connect Discord'}</h1>
  <p>${safe}</p>
  <p style="margin-top:1rem">You can close this window.</p>
</main>
<script>
  // Opened as a popup by the desktop client: tell the opener and get out of
  // the way. A normal tab has no opener and simply stays put.
  try {
    if (window.opener) {
      window.opener.postMessage({ source: 'gameblade-discord', ok: ${ok} }, '*');
      setTimeout(function () { window.close(); }, 800);
    }
  } catch (e) { /* a blocked opener is not worth reporting */ }
</script>
</body></html>`);
}
