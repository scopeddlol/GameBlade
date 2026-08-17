import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SAVE_BYTES,
  SAVE_VERSIONS_KEPT,
  type SaveSlotInfo,
  type SaveSyncStatus,
  type SaveUploadInput,
  type SaveVersionInfo,
} from '@gameblade/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { devices, games, saveSlots, saveVersions } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { writeHashedStream } from '../lib/stream.js';
import { isoNow } from '../lib/time.js';

/**
 * Cloud saves are stored as opaque archives: the client zips whatever the
 * game's save rule matched, hashes it, and uploads the blob. The server never
 * inspects the contents, which is what lets one implementation cover every game
 * without per-title knowledge.
 *
 * Versions are immutable and pruned by count, so a bad sync is always
 * recoverable by rolling back to an earlier one.
 */
export class SaveService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.savesDir, { recursive: true });
  }

  /** Archives are sharded by slot so one directory never holds every save. */
  private versionPath(slotId: string, versionId: string): string {
    return path.join(this.config.savesDir, slotId, `${versionId}.zip`);
  }

  listSlots(userId: string, gameId?: string): SaveSlotInfo[] {
    const conditions = [eq(saveSlots.userId, userId)];
    if (gameId) conditions.push(eq(saveSlots.gameId, gameId));

    const slots = this.db
      .select()
      .from(saveSlots)
      .where(and(...conditions))
      .orderBy(desc(saveSlots.updatedAt))
      .all();

    return slots.map((slot) => this.describeSlot(slot));
  }

  getSlot(userId: string, slotId: string): SaveSlotInfo {
    const slot = this.db
      .select()
      .from(saveSlots)
      .where(and(eq(saveSlots.id, slotId), eq(saveSlots.userId, userId)))
      .get();
    if (!slot) throw ApiError.notFound('That save slot does not exist');
    return this.describeSlot(slot);
  }

  listVersions(userId: string, slotId: string): SaveVersionInfo[] {
    const slot = this.db
      .select({ id: saveSlots.id })
      .from(saveSlots)
      .where(and(eq(saveSlots.id, slotId), eq(saveSlots.userId, userId)))
      .get();
    if (!slot) throw ApiError.notFound('That save slot does not exist');

    const rows = this.db
      .select()
      .from(saveVersions)
      .where(eq(saveVersions.slotId, slotId))
      .orderBy(desc(saveVersions.createdAt))
      .all();

    return rows.map((row) => this.describeVersion(row));
  }

  /**
   * Tells a client what to do before it uploads anything.
   *
   * The client supplies the digest it currently has on disk and the digest it
   * last synced. When the remote head has moved on from that base *and* the
   * local copy has also changed, both sides hold edits and the client must ask
   * the user rather than silently overwriting one of them.
   */
  status(
    userId: string,
    gameId: string,
    slotName: string,
    local: { sha256: string | null; capturedAt: string | null; baseSha256: string | null },
  ): SaveSyncStatus {
    const slot = this.db
      .select()
      .from(saveSlots)
      .where(
        and(
          eq(saveSlots.userId, userId),
          eq(saveSlots.gameId, gameId),
          eq(saveSlots.name, slotName),
        ),
      )
      .get();

    const remote = slot?.currentVersionId
      ? this.db
          .select()
          .from(saveVersions)
          .where(eq(saveVersions.id, slot.currentVersionId))
          .get()
      : undefined;

    const remoteInfo = remote ? this.describeVersion(remote) : null;
    const base = {
      slotId: slot?.id ?? null,
      gameId,
      remote: remoteInfo,
      localSha256: local.sha256,
      localCapturedAt: local.capturedAt,
    };

    if (!remoteInfo) {
      return { ...base, state: local.sha256 ? 'no-remote' : 'no-local' };
    }
    if (!local.sha256) {
      return { ...base, state: 'no-local' };
    }
    if (local.sha256 === remoteInfo.sha256) {
      return { ...base, state: 'in-sync' };
    }

    const remoteMovedOn = local.baseSha256 !== null && local.baseSha256 !== remoteInfo.sha256;
    const localChanged = local.baseSha256 === null || local.baseSha256 !== local.sha256;

    if (remoteMovedOn && localChanged) {
      return { ...base, state: 'conflict' };
    }
    if (remoteMovedOn) {
      return { ...base, state: 'remote-newer' };
    }
    if (localChanged) {
      return { ...base, state: 'local-newer' };
    }

    // Digests differ but neither side reports an edit: fall back to timestamps.
    const localNewer =
      local.capturedAt !== null && local.capturedAt > remoteInfo.capturedAt;
    return { ...base, state: localNewer ? 'local-newer' : 'remote-newer' };
  }

  /**
   * Streams an uploaded archive to disk and records it as the slot's new head.
   *
   * The stream is hashed while it is written, and a digest that does not match
   * what the client declared aborts the upload — a truncated or corrupted save
   * must never become the version everyone else pulls.
   */
  async upload(
    userId: string,
    input: SaveUploadInput,
    body: NodeJS.ReadableStream,
    deviceId: string | null,
  ): Promise<SaveVersionInfo> {
    const game = this.db
      .select({ id: games.id })
      .from(games)
      .where(eq(games.id, input.gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    await this.assertQuota(userId, input.sizeBytes);

    const slot = this.ensureSlot(userId, input.gameId, input.slotName);

    if (!input.force) {
      const status = this.status(userId, input.gameId, input.slotName, {
        sha256: input.sha256,
        capturedAt: input.capturedAt,
        baseSha256: input.baseSha256 ?? null,
      });
      if (status.state === 'conflict') {
        throw new ApiError(
          409,
          'save_conflict',
          'This save changed on another device since your last sync',
          { remote: status.remote },
        );
      }
    }

    const versionId = newId('sav');
    const target = this.versionPath(slot.id, versionId);
    await mkdir(path.dirname(target), { recursive: true });

    const { sha256: digest, bytes } = await writeHashedStream(body, target, MAX_SAVE_BYTES, () =>
      ApiError.badRequest('That save archive is larger than the upload limit'),
    );

    if (digest !== input.sha256) {
      await rm(target, { force: true });
      throw ApiError.badRequest('The uploaded save did not match its checksum');
    }

    const record = {
      id: versionId,
      slotId: slot.id,
      sha256: digest,
      sizeBytes: bytes,
      fileCount: input.fileCount,
      deviceId,
      capturedAt: input.capturedAt,
      createdAt: isoNow(),
    };

    this.db.insert(saveVersions).values(record).run();
    this.db
      .update(saveSlots)
      .set({ currentVersionId: versionId, updatedAt: isoNow() })
      .where(eq(saveSlots.id, slot.id))
      .run();

    await this.pruneVersions(slot.id);
    this.logger.info(
      { userId, gameId: input.gameId, slot: input.slotName, bytes },
      'stored a cloud save version',
    );

    return this.describeVersion(record);
  }

  /** Opens a stored archive for download, newest version unless one is named. */
  async openVersion(
    userId: string,
    slotId: string,
    versionId?: string,
  ): Promise<{ stream: NodeJS.ReadableStream; version: SaveVersionInfo }> {
    const slot = this.db
      .select()
      .from(saveSlots)
      .where(and(eq(saveSlots.id, slotId), eq(saveSlots.userId, userId)))
      .get();
    if (!slot) throw ApiError.notFound('That save slot does not exist');

    const wanted = versionId ?? slot.currentVersionId;
    if (!wanted) throw ApiError.notFound('This slot has no saved version yet');

    const version = this.db
      .select()
      .from(saveVersions)
      .where(and(eq(saveVersions.id, wanted), eq(saveVersions.slotId, slotId)))
      .get();
    if (!version) throw ApiError.notFound('That save version does not exist');

    const file = this.versionPath(slotId, version.id);
    try {
      await stat(file);
    } catch {
      throw ApiError.notFound('That save version is no longer on disk');
    }

    return { stream: createReadStream(file), version: this.describeVersion(version) };
  }

  /** Promotes an older version back to the head, for "restore this backup". */
  restore(userId: string, slotId: string, versionId: string): SaveSlotInfo {
    const slot = this.db
      .select()
      .from(saveSlots)
      .where(and(eq(saveSlots.id, slotId), eq(saveSlots.userId, userId)))
      .get();
    if (!slot) throw ApiError.notFound('That save slot does not exist');

    const version = this.db
      .select({ id: saveVersions.id })
      .from(saveVersions)
      .where(and(eq(saveVersions.id, versionId), eq(saveVersions.slotId, slotId)))
      .get();
    if (!version) throw ApiError.notFound('That save version does not exist');

    this.db
      .update(saveSlots)
      .set({ currentVersionId: versionId, updatedAt: isoNow() })
      .where(eq(saveSlots.id, slotId))
      .run();

    return this.getSlot(userId, slotId);
  }

  async deleteSlot(userId: string, slotId: string): Promise<void> {
    const slot = this.db
      .select({ id: saveSlots.id })
      .from(saveSlots)
      .where(and(eq(saveSlots.id, slotId), eq(saveSlots.userId, userId)))
      .get();
    if (!slot) throw ApiError.notFound('That save slot does not exist');

    // Rows cascade, but the archives on disk are ours to clean up.
    this.db.delete(saveSlots).where(eq(saveSlots.id, slotId)).run();
    await rm(path.join(this.config.savesDir, slotId), { recursive: true, force: true });
  }

  /** Bytes this user is currently occupying, shown in desktop Settings. */
  usage(userId: string): { bytes: number; slots: number; versions: number } {
    const row = this.db
      .select({
        bytes: sql<number>`coalesce(sum(${saveVersions.sizeBytes}), 0)`,
        versions: sql<number>`count(*)`,
      })
      .from(saveVersions)
      .innerJoin(saveSlots, eq(saveSlots.id, saveVersions.slotId))
      .where(eq(saveSlots.userId, userId))
      .get();

    const slots = this.db
      .select({ count: sql<number>`count(*)` })
      .from(saveSlots)
      .where(eq(saveSlots.userId, userId))
      .get();

    return {
      bytes: row?.bytes ?? 0,
      versions: row?.versions ?? 0,
      slots: slots?.count ?? 0,
    };
  }

  private ensureSlot(userId: string, gameId: string, name: string) {
    const existing = this.db
      .select()
      .from(saveSlots)
      .where(
        and(eq(saveSlots.userId, userId), eq(saveSlots.gameId, gameId), eq(saveSlots.name, name)),
      )
      .get();
    if (existing) return existing;

    const record = {
      id: newId('slt'),
      userId,
      gameId,
      name,
      currentVersionId: null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    this.db.insert(saveSlots).values(record).run();
    return record;
  }

  private async assertQuota(userId: string, incoming: number): Promise<void> {
    if (this.config.saveQuotaBytes === 0) return;
    const { bytes } = this.usage(userId);
    if (bytes + incoming > this.config.saveQuotaBytes) {
      throw ApiError.badRequest(
        'This upload would exceed your cloud save quota. Delete old slots and try again.',
      );
    }
  }

  /** Keeps the newest N versions per slot; older archives are deleted. */
  private async pruneVersions(slotId: string): Promise<void> {
    const rows = this.db
      .select({ id: saveVersions.id })
      .from(saveVersions)
      .where(eq(saveVersions.slotId, slotId))
      .orderBy(desc(saveVersions.createdAt))
      .all();

    const stale = rows.slice(SAVE_VERSIONS_KEPT);
    for (const row of stale) {
      this.db.delete(saveVersions).where(eq(saveVersions.id, row.id)).run();
      await rm(this.versionPath(slotId, row.id), { force: true });
    }
  }

  private describeSlot(slot: typeof saveSlots.$inferSelect): SaveSlotInfo {
    const current = slot.currentVersionId
      ? this.db
          .select()
          .from(saveVersions)
          .where(eq(saveVersions.id, slot.currentVersionId))
          .get()
      : undefined;

    const count = this.db
      .select({ count: sql<number>`count(*)` })
      .from(saveVersions)
      .where(eq(saveVersions.slotId, slot.id))
      .get();

    return {
      id: slot.id,
      gameId: slot.gameId,
      name: slot.name,
      updatedAt: slot.updatedAt,
      currentVersion: current ? this.describeVersion(current) : null,
      versionCount: count?.count ?? 0,
    };
  }

  private describeVersion(version: typeof saveVersions.$inferSelect): SaveVersionInfo {
    const device = version.deviceId
      ? this.db
          .select({ name: devices.name })
          .from(devices)
          .where(eq(devices.id, version.deviceId))
          .get()
      : undefined;

    return {
      id: version.id,
      sizeBytes: version.sizeBytes,
      fileCount: version.fileCount,
      sha256: version.sha256,
      deviceId: version.deviceId,
      // A revoked device leaves its saves behind; label them rather than hiding.
      deviceName: device?.name ?? null,
      createdAt: version.createdAt,
      capturedAt: version.capturedAt,
    };
  }
}
