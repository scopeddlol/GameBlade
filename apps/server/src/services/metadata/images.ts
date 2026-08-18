import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { images } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { HttpError, withRetry } from '../../lib/ratelimit.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

export type ImageKind = 'cover' | 'banner' | 'hero' | 'logo' | 'icon' | 'screenshot';

/**
 * Downloads provider artwork once and serves it from local disk afterwards.
 *
 * Caching matters for more than speed: it means the library keeps rendering if
 * IGDB or SteamGridDB is unreachable, and browsers never hit third-party hosts,
 * so no client IP leaks to a provider.
 */
export class ImageCache {
  constructor(
    private readonly db: Db,
    private readonly cacheDir: string,
    private readonly logger: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  async init(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  filePath(id: string, contentType: string): string {
    return path.join(this.cacheDir, `${id}${EXTENSION_BY_TYPE[contentType] ?? '.bin'}`);
  }

  findByUrl(url: string) {
    return this.db.select().from(images).where(eq(images.sourceUrl, url)).get();
  }

  findById(id: string) {
    return this.db.select().from(images).where(eq(images.id, id)).get();
  }

  /**
   * Fetch and store an image, returning its id. Returns null instead of throwing
   * when the download fails — missing artwork must never fail a whole scan.
   */
  async cache(url: string, kind: ImageKind): Promise<string | null> {
    const existing = this.findByUrl(url);
    if (existing) {
      // Trust the row only if the file is still on disk.
      const onDisk = await stat(this.filePath(existing.id, existing.contentType)).catch(() => null);
      if (onDisk?.isFile()) return existing.id;
      this.db.delete(images).where(eq(images.id, existing.id)).run();
    }

    try {
      return await withRetry(() => this.download(url, kind), { attempts: 2 });
    } catch (error) {
      this.logger.warn({ err: error, url }, 'failed to cache artwork');
      return null;
    }
  }

  private async download(url: string, kind: ImageKind): Promise<string> {
    const response = await fetch(url, { headers: { Accept: 'image/*' } });
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, `image download failed (${response.status})`);
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!contentType.startsWith('image/')) {
      throw new HttpError(415, `unexpected content type "${contentType}"`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new HttpError(413, 'image exceeds the size limit');
    }

    const id = newId('img');
    const destination = this.filePath(id, contentType);
    await mkdir(path.dirname(destination), { recursive: true });

    let written = 0;
    const source = Readable.fromWeb(response.body as never);
    // Enforce the cap while streaming, since content-length may be absent or lie.
    source.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > MAX_IMAGE_BYTES) {
        source.destroy(new HttpError(413, 'image exceeds the size limit'));
      }
    });

    try {
      await pipeline(source, createWriteStream(destination));
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }

    this.db
      .insert(images)
      .values({
        id,
        kind,
        sourceUrl: url,
        contentType,
        sizeBytes: written,
        createdAt: new Date().toISOString(),
      })
      .run();

    return id;
  }

  /**
   * Cache a list of URLs, dropping the ones that fail. Downloads run in
   * sequence: a metadata edit is rarely more than a handful of screenshots, and
   * hammering a provider in parallel is what gets an IP rate-limited.
   */
  async cacheMany(urls: string[], kind: ImageKind): Promise<string[]> {
    const ids: string[] = [];
    for (const url of urls) {
      const id = await this.cache(url, kind);
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Remove a cached image and its file. */
  async remove(id: string): Promise<void> {
    const record = this.findById(id);
    if (!record) return;
    await rm(this.filePath(id, record.contentType), { force: true });
    this.db.delete(images).where(eq(images.id, id)).run();
  }
}
