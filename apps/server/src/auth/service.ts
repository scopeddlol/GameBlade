import {
  DEVICE_TOKEN_TTL_DAYS,
  SESSION_TTL_DAYS,
  type PublicUser,
  type Role,
} from '@gameblade/shared';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices, invites, sessions, users, type User } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { hashToken, newId, newToken, normaliseInviteCode } from '../lib/ids.js';
import { fakeVerify, hashPassword, verifyPassword } from './password.js';

export interface AuthContext {
  user: User;
  /** Present for cookie sessions; desktop clients authenticate per-request. */
  session?: { tokenHash: string; csrfToken: string };
  device?: { id: string };
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export class AuthService {
  constructor(private readonly db: Db) {}

  async createUser(input: {
    username: string;
    password: string;
    email?: string | null;
    role?: Role;
  }): Promise<User> {
    const usernameLower = input.username.toLowerCase();
    const existing = this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, usernameLower))
      .get();
    if (existing) {
      throw ApiError.conflict('That username is already taken');
    }

    const record = {
      id: newId('usr'),
      username: input.username,
      usernameLower,
      email: input.email?.trim() ? input.email.trim() : null,
      passwordHash: await hashPassword(input.password),
      role: input.role ?? 'user',
      isActive: true,
      createdAt: isoNow(),
      lastLoginAt: null,
    };

    this.db.insert(users).values(record).run();
    return record as User;
  }

  countUsers(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .get();
    return row?.count ?? 0;
  }

  findByUsername(username: string): User | undefined {
    return this.db
      .select()
      .from(users)
      .where(eq(users.usernameLower, username.trim().toLowerCase()))
      .get();
  }

  findById(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  /**
   * Verify credentials. Always runs a hash comparison — even for unknown users —
   * so response time does not disclose whether an account exists.
   */
  async authenticate(username: string, password: string): Promise<User> {
    const user = this.findByUsername(username);
    if (!user) {
      await fakeVerify();
      throw ApiError.unauthorized('Incorrect username or password');
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      throw ApiError.unauthorized('Incorrect username or password');
    }
    if (!user.isActive) {
      throw ApiError.forbidden('This account has been disabled');
    }

    this.db.update(users).set({ lastLoginAt: isoNow() }).where(eq(users.id, user.id)).run();
    return user;
  }

  createSession(
    userId: string,
    meta: { userAgent?: string | null; ip?: string | null } = {},
  ): { token: string; csrfToken: string; expiresAt: string } {
    const token = newToken(32);
    const csrfToken = newToken(24);
    const expiresAt = isoIn(SESSION_TTL_DAYS);

    this.db
      .insert(sessions)
      .values({
        tokenHash: hashToken(token),
        userId,
        csrfToken,
        createdAt: isoNow(),
        expiresAt,
        lastSeenAt: isoNow(),
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
        ip: meta.ip ?? null,
      })
      .run();

    return { token, csrfToken, expiresAt };
  }

  resolveSession(token: string): AuthContext | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .get();

    if (!row) return null;
    if (new Date(row.session.expiresAt).getTime() <= Date.now()) {
      this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
      return null;
    }
    if (!row.user.isActive) return null;

    this.db
      .update(sessions)
      .set({ lastSeenAt: isoNow() })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();

    return {
      user: row.user,
      session: { tokenHash, csrfToken: row.session.csrfToken },
    };
  }

  destroySession(token: string): void {
    this.db
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .run();
  }

  destroyAllSessions(userId: string): void {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  createDeviceToken(
    userId: string,
    name: string,
    platform?: string | null,
  ): { token: string; deviceId: string; expiresAt: string } {
    const token = newToken(40);
    const deviceId = newId('dev');
    const expiresAt = isoIn(DEVICE_TOKEN_TTL_DAYS);

    this.db
      .insert(devices)
      .values({
        id: deviceId,
        userId,
        tokenHash: hashToken(token),
        name: name.slice(0, 64),
        platform: platform?.slice(0, 64) ?? null,
        createdAt: isoNow(),
        expiresAt,
        lastSeenAt: isoNow(),
      })
      .run();

    return { token, deviceId, expiresAt };
  }

  resolveDeviceToken(token: string): AuthContext | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .select({ device: devices, user: users })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.tokenHash, tokenHash))
      .get();

    if (!row) return null;
    if (new Date(row.device.expiresAt).getTime() <= Date.now()) {
      this.db.delete(devices).where(eq(devices.id, row.device.id)).run();
      return null;
    }
    if (!row.user.isActive) return null;

    this.db
      .update(devices)
      .set({ lastSeenAt: isoNow() })
      .where(eq(devices.id, row.device.id))
      .run();

    return { user: row.user, device: { id: row.device.id } };
  }

  revokeDevice(userId: string, deviceId: string): void {
    this.db
      .delete(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .run();
  }

  listDevices(userId: string) {
    return this.db.select().from(devices).where(eq(devices.userId, userId)).all();
  }

  /**
   * Validate an invite and atomically claim one use. Returns the role the new
   * account should get.
   */
  claimInvite(rawCode: string): Role {
    const code = normaliseInviteCode(rawCode);
    const invite = this.db.select().from(invites).where(eq(invites.code, code)).get();

    if (!invite) throw ApiError.badRequest('That invite code is not valid');
    if (invite.revokedAt) throw ApiError.gone('That invite has been revoked');
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw ApiError.gone('That invite has expired');
    }

    // Conditional update doubles as the concurrency guard: if two registrations
    // race for the last use, only one UPDATE reports a changed row.
    const result = this.db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(and(eq(invites.id, invite.id), lt(invites.uses, invite.maxUses)))
      .run();

    if (result.changes === 0) {
      throw ApiError.gone('That invite has already been used');
    }
    return invite.role;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = this.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) throw ApiError.badRequest('Your current password is incorrect');

    this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId))
      .run();

    // Changing a password invalidates every other login for that account.
    this.destroyAllSessions(userId);
    this.db.delete(devices).where(eq(devices.userId, userId)).run();
  }

  /**
   * Self-service username/email change. Deliberately narrower than the admin
   * PATCH: no role, no isActive, no password reset without the current one —
   * this is what `/account` exposes to any signed-in user about themselves.
   */
  async updateAccount(
    userId: string,
    patch: { username?: string; email?: string | null },
  ): Promise<User> {
    const user = this.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const update: Partial<Pick<User, 'username' | 'usernameLower' | 'email'>> = {};

    if (patch.username !== undefined && patch.username !== user.username) {
      const usernameLower = patch.username.toLowerCase();
      const existing = this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.usernameLower, usernameLower))
        .get();
      if (existing && existing.id !== userId) {
        throw ApiError.conflict('That username is already taken');
      }
      update.username = patch.username;
      update.usernameLower = usernameLower;
    }

    if (patch.email !== undefined) {
      update.email = patch.email?.trim() ? patch.email.trim() : null;
    }

    if (Object.keys(update).length > 0) {
      this.db.update(users).set(update).where(eq(users.id, userId)).run();
    }

    // Non-null: the row was just confirmed to exist, and this method is the
    // only writer to touch it between the read above and here.
    return this.findById(userId) as User;
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId))
      .run();
    this.destroyAllSessions(userId);
    this.db.delete(devices).where(eq(devices.userId, userId)).run();
  }

  /** Drop expired sessions, devices and invites. Cheap enough to run hourly. */
  pruneExpired(): void {
    const now = isoNow();
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    this.db.delete(devices).where(lt(devices.expiresAt, now)).run();
    this.db
      .delete(invites)
      .where(
        and(
          or(lt(invites.expiresAt, now), sql`${invites.uses} >= ${invites.maxUses}`),
          isNull(invites.revokedAt),
        ),
      )
      .run();
  }
}
