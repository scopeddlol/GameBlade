import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClientInstallerInfo } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { writeHashedStream } from '../lib/stream.js';
import { isoNow } from '../lib/time.js';

/** The one settings row holding everything known about the stored installer. */
const SETTING_KEY = 'clientInstaller';

interface StoredInstaller {
  fileName: string;
  /** Name on disk, which is the digest — never the client-supplied name. */
  storedName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

/** How long an in-flight upload's partial file is left alone by the sweep. */
const PENDING_GRACE_MS = 60 * 60 * 1000;

/** Extensions an operator can plausibly hand out as "the Windows client". */
const ALLOWED_EXTENSIONS = ['.exe', '.msi', '.msix', '.appinstaller', '.zip'];

/**
 * Holds the Windows client installer on the server, so an administrator can
 * upload a build instead of hosting it somewhere else and pasting a link.
 *
 * Exactly one installer exists at a time: the landing page has one Download
 * button, and keeping a history would mean deciding which of them that button
 * points at. Replacing simply overwrites.
 */
export class InstallerService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.installerDir, { recursive: true });
  }

  /** The public download URL, which is a route on this server rather than a file path. */
  get downloadUrl(): string {
    return `${this.config.basePath}/api/client/download`;
  }

  private record(): StoredInstaller | null {
    const row = this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, SETTING_KEY))
      .get();
    const value = row?.value as StoredInstaller | null | undefined;
    return value && typeof value === 'object' ? value : null;
  }

  info(): ClientInstallerInfo | null {
    const stored = this.record();
    if (!stored) return null;
    return {
      fileName: stored.fileName,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      uploadedAt: stored.uploadedAt,
      url: this.downloadUrl,
    };
  }

  /**
   * Streams an upload to disk while hashing it, then makes it the current
   * installer. The digest is the name on disk: a client-supplied filename is
   * untrusted input, and one that resolved out of the directory would be a
   * write anywhere the server can reach.
   */
  async store(
    input: { fileName: string; contentType: string },
    body: NodeJS.ReadableStream,
    maxBytes: number,
  ): Promise<ClientInstallerInfo> {
    const fileName = sanitizeFileName(input.fileName);
    const extension = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      throw ApiError.badRequest(
        `The installer must be one of: ${ALLOWED_EXTENSIONS.join(', ')}. Got "${extension || 'no extension'}".`,
      );
    }

    await mkdir(this.config.installerDir, { recursive: true });
    const pending = path.join(this.config.installerDir, `pending-${Date.now()}${extension}`);

    const { sha256, bytes } = await writeHashedStream(body, pending, maxBytes, () =>
      ApiError.badRequest('That installer is larger than the upload limit'),
    );

    if (bytes === 0) {
      await rm(pending, { force: true });
      throw ApiError.badRequest('That file is empty');
    }

    const storedName = `${sha256}${extension}`;
    const target = path.join(this.config.installerDir, storedName);
    // A re-upload of the identical build lands on the same name; renaming over
    // it is fine, the bytes are the same by definition.
    await rename(pending, target);

    const previous = this.record();
    const stored: StoredInstaller = {
      fileName,
      storedName,
      contentType: input.contentType.split(';')[0]?.trim() || 'application/octet-stream',
      sizeBytes: bytes,
      sha256,
      uploadedAt: isoNow(),
    };
    this.write(stored);

    if (previous && previous.storedName !== storedName) {
      await rm(path.join(this.config.installerDir, previous.storedName), { force: true });
    }
    await this.collectStrays(storedName);

    return this.info() as ClientInstallerInfo;
  }

  /** Opens the current installer for download, or reports that there is none. */
  async open(): Promise<{
    stream: NodeJS.ReadableStream;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }> {
    const stored = this.record();
    if (!stored) throw ApiError.notFound('No installer has been uploaded');

    const file = path.join(this.config.installerDir, stored.storedName);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      throw ApiError.notFound('The uploaded installer is no longer on disk');
    }

    return {
      stream: createReadStream(file),
      fileName: stored.fileName,
      contentType: stored.contentType,
      // Trust the file, not the row: a truncated write would otherwise send a
      // Content-Length the body never satisfies and hang the download.
      sizeBytes: info.size,
    };
  }

  async remove(): Promise<void> {
    const stored = this.record();
    this.db.delete(settingsTable).where(eq(settingsTable.key, SETTING_KEY)).run();
    if (stored) {
      await rm(path.join(this.config.installerDir, stored.storedName), { force: true });
    }
    await this.collectStrays(null);
  }

  private write(stored: StoredInstaller): void {
    const now = isoNow();
    this.db
      .insert(settingsTable)
      .values({ key: SETTING_KEY, value: stored, updatedAt: now })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: stored, updatedAt: now },
      })
      .run();
  }

  /**
   * Removes anything in the directory that is not the current installer.
   *
   * An upload that dies mid-stream leaves a `pending-` file behind, and the
   * directory is ours alone, so sweeping it keeps a long-lived server from
   * accumulating abandoned half-gigabyte builds. A recently touched `pending-`
   * file is left alone: it is far more likely to be another upload still
   * streaming than a stray.
   */
  private async collectStrays(keep: string | null): Promise<void> {
    const entries = await readdir(this.config.installerDir).catch(() => []);
    const cutoff = Date.now() - PENDING_GRACE_MS;

    for (const entry of entries) {
      if (entry === keep) continue;
      const file = path.join(this.config.installerDir, entry);
      if (entry.startsWith('pending-')) {
        const info = await stat(file).catch(() => null);
        if (info && info.mtimeMs > cutoff) continue;
      }
      await rm(file, { force: true });
    }
  }
}

/** Strips any path from a client-supplied name and keeps it to safe characters. */
function sanitizeFileName(raw: string): string {
  const base = path.basename(raw.trim().replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!cleaned) throw ApiError.badRequest('The upload needs a file name');
  return cleaned.slice(0, 120);
}
