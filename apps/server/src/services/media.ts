import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaInfo, MediaKind } from '@gameblade/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { media, postMedia, userProfiles } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { writeHashedStream } from '../lib/stream.js';
import { isoNow } from '../lib/time.js';

/** Content types accepted per kind. Anything else is rejected before writing. */
const ALLOWED_TYPES: Record<MediaKind, readonly string[]> = {
  avatar: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  banner: ['image/png', 'image/jpeg', 'image/webp'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'],
  clip: ['video/mp4', 'video/webm'],
};

/**
 * Stores user uploads on disk, addressed by row id and sharded two levels deep
 * so no single directory ends up with tens of thousands of entries.
 */
export class MediaStore {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.mediaDir, { recursive: true });
  }

  private filePath(id: string): string {
    // Ids are base64url, so the first characters are well distributed.
    const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
    return path.join(this.config.mediaDir, body.slice(0, 2), body.slice(2, 4), id);
  }

  url(id: string): string {
    return `${this.config.basePath}/api/media/${id}`;
  }

  assertAcceptable(kind: MediaKind, contentType: string, sizeBytes: number): void {
    const allowed = ALLOWED_TYPES[kind];
    const normalised = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!allowed.includes(normalised)) {
      throw ApiError.badRequest(`${kind} uploads must be one of: ${allowed.join(', ')}`);
    }
    if (sizeBytes <= 0) {
      throw ApiError.badRequest('That file is empty');
    }
  }

  /**
   * Streams an upload to disk while hashing it, then records the row.
   *
   * The declared size is treated as a hint for the quota check only; the byte
   * count that lands in the database is what was actually written, so a client
   * cannot under-report to slip past its quota.
   */
  async store(
    ownerId: string,
    input: {
      kind: MediaKind;
      contentType: string;
      sizeBytes: number;
      width?: number | null;
      height?: number | null;
      durationMs?: number | null;
    },
    body: NodeJS.ReadableStream,
    maxBytes: number,
  ): Promise<MediaInfo> {
    this.assertAcceptable(input.kind, input.contentType, input.sizeBytes);
    await this.assertQuota(ownerId, input.sizeBytes);

    const id = newId('med');
    const target = this.filePath(id);
    await mkdir(path.dirname(target), { recursive: true });

    const { sha256, bytes } = await writeHashedStream(body, target, maxBytes, () =>
      ApiError.badRequest('That file is larger than the upload limit'),
    );

    if (bytes === 0) {
      await rm(target, { force: true });
      throw ApiError.badRequest('That file is empty');
    }

    const record = {
      id,
      ownerId,
      kind: input.kind,
      contentType: input.contentType.split(';')[0]?.trim() ?? input.contentType,
      sizeBytes: bytes,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
      sha256,
      createdAt: isoNow(),
    };
    this.db.insert(media).values(record).run();

    this.logger.debug({ ownerId, kind: input.kind, bytes }, 'stored a media upload');
    return this.toInfo(record);
  }

  async open(id: string): Promise<{ stream: NodeJS.ReadableStream; record: MediaInfo }> {
    const record = this.db.select().from(media).where(eq(media.id, id)).get();
    if (!record) throw ApiError.notFound('That file does not exist');

    const file = this.filePath(id);
    try {
      await stat(file);
    } catch {
      throw ApiError.notFound('That file is no longer on disk');
    }
    return { stream: createReadStream(file), record: this.toInfo(record) };
  }

  get(id: string) {
    return this.db.select().from(media).where(eq(media.id, id)).get();
  }

  infoFor(ids: string[]): Map<string, MediaInfo> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(media)
      .where(inArray(media.id, [...new Set(ids)]))
      .all();
    return new Map(rows.map((row) => [row.id, this.toInfo(row)]));
  }

  /** Only the owner may attach or delete their own upload. */
  assertOwned(ownerId: string, ids: string[]): void {
    if (ids.length === 0) return;
    const rows = this.db
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.id, ids), eq(media.ownerId, ownerId)))
      .all();
    if (rows.length !== new Set(ids).size) {
      throw ApiError.badRequest('One of those attachments is not yours');
    }
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const record = this.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), eq(media.ownerId, ownerId)))
      .get();
    if (!record) throw ApiError.notFound('That file does not exist');

    this.db.delete(media).where(eq(media.id, id)).run();
    await rm(this.filePath(id), { force: true });
  }

  usage(ownerId: string): number {
    const row = this.db
      .select({ bytes: sql<number>`coalesce(sum(${media.sizeBytes}), 0)` })
      .from(media)
      .where(eq(media.ownerId, ownerId))
      .get();
    return row?.bytes ?? 0;
  }

  /**
   * Removes uploads that nothing references — neither a post nor a profile.
   * The desktop client uploads before it composes, so an abandoned draft would
   * otherwise leak a file per attempt.
   */
  async collectOrphans(olderThanIso: string): Promise<number> {
    const rows = this.db
      .select({ id: media.id })
      .from(media)
      .where(
        and(
          sql`${media.createdAt} < ${olderThanIso}`,
          sql`${media.id} NOT IN (SELECT media_id FROM ${postMedia})`,
          sql`${media.id} NOT IN (SELECT avatar_media_id FROM ${userProfiles} WHERE avatar_media_id IS NOT NULL)`,
          sql`${media.id} NOT IN (SELECT banner_media_id FROM ${userProfiles} WHERE banner_media_id IS NOT NULL)`,
        ),
      )
      .all();

    for (const row of rows) {
      this.db.delete(media).where(eq(media.id, row.id)).run();
      await rm(this.filePath(row.id), { force: true });
    }
    if (rows.length > 0) {
      this.logger.info({ removed: rows.length }, 'collected orphaned media uploads');
    }
    return rows.length;
  }

  private async assertQuota(ownerId: string, incoming: number): Promise<void> {
    if (this.config.mediaQuotaBytes === 0) return;
    if (this.usage(ownerId) + incoming > this.config.mediaQuotaBytes) {
      throw ApiError.badRequest(
        'This upload would exceed your storage quota. Delete some clips and try again.',
      );
    }
  }

  private toInfo(record: typeof media.$inferSelect): MediaInfo {
    return {
      id: record.id,
      kind: record.kind,
      url: this.url(record.id),
      // Clips are served as-is; browsers and the client both seek an mp4 or
      // webm natively, so no separate poster asset is generated.
      thumbnailUrl: null,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      width: record.width,
      height: record.height,
      durationMs: record.durationMs,
    };
  }
}
