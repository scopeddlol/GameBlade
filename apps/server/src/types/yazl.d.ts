/**
 * yazl 3.x ships no type definitions, and the DefinitelyTyped package
 * (`@types/yazl`) still describes the 2.x API — notably it types the `end`
 * callback as taking no arguments, when 3.x passes the calculated archive size.
 *
 * These declarations cover the surface GameBlade actually uses.
 */
declare module 'yazl' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface EntryOptions {
    mtime: Date;
    mode: number;
    /** Deflate when true; GameBlade stores entries so sizes stay predictable. */
    compress: boolean;
    forceZip64Format: boolean;
    fileComment: string;
  }

  export interface ReadStreamOptions extends EntryOptions {
    /** Required for a stream, since yazl cannot stat it. */
    size: number;
  }

  export interface EndOptions {
    forceZip64Format?: boolean;
    comment?: string | Buffer;
  }

  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable;

    addFile(realPath: string, metadataPath: string, options?: Partial<EntryOptions>): void;
    addReadStream(
      readStream: Readable,
      metadataPath: string,
      options?: Partial<ReadStreamOptions>,
    ): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: Partial<EntryOptions>): void;
    addEmptyDirectory(metadataPath: string, options?: Partial<EntryOptions>): void;

    /**
     * `calculatedTotalSizeCallback` fires only once every entry's size is known,
     * which may be after `end()` returns — or never, if a size cannot be
     * determined. Callers must not block on it indefinitely.
     */
    end(options?: EndOptions, calculatedTotalSizeCallback?: (totalSize: number) => void): void;
    end(calculatedTotalSizeCallback?: (totalSize: number) => void): void;
  }

  export function dateToDosDateTime(jsDate: Date): { date: number; time: number };
}
