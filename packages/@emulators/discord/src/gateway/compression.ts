import { createDeflate, createZstdCompress, constants } from "node:zlib";
import type { Transform } from "node:stream";

/** A zlib/zstd transform stream exposes a `flush(kind, cb)` used to terminate each message. */
type FlushableStream = Transform & { flush(kind: number, callback: () => void): void; close(): void };

/**
 * Per-connection streaming compressor for the Gateway (transport `compress=zlib-stream` or
 * `zstd-stream`). Discord uses a single shared context for the whole connection, flushing each
 * message (Z_SYNC_FLUSH for zlib, ZSTD_e_flush for zstd) so the client decodes every payload with
 * one matching streaming context. Calls are serialized through an internal promise chain because the
 * stream is stateful and must process one message at a time, in order.
 */
export class StreamCompressor {
  private chunks: Buffer[] = [];
  private queue: Promise<Buffer> = Promise.resolve(Buffer.alloc(0));

  constructor(
    private readonly stream: FlushableStream,
    private readonly flushKind: number,
  ) {
    stream.on("data", (chunk: Buffer) => this.chunks.push(chunk));
  }

  compress(data: string | Buffer): Promise<Buffer> {
    this.queue = this.queue.then(
      () =>
        new Promise<Buffer>((resolve) => {
          this.stream.write(data, () => {
            this.stream.flush(this.flushKind, () => {
              const out = Buffer.concat(this.chunks);
              this.chunks = [];
              resolve(out);
            });
          });
        }),
    );
    return this.queue;
  }

  close(): void {
    try {
      this.stream.close();
    } catch {
      // ignore
    }
  }
}

/** zlib-stream compressor (discord.py's legacy default; discord.js when zlib is requested). */
export function createZlibStreamCompressor(): StreamCompressor {
  return new StreamCompressor(createDeflate() as FlushableStream, constants.Z_SYNC_FLUSH);
}

/** zstd-stream compressor (discord.py 2.7+ default when `zstandard` is installed; Discord since 2024). */
export function createZstdStreamCompressor(): StreamCompressor {
  return new StreamCompressor(createZstdCompress() as FlushableStream, constants.ZSTD_e_flush);
}
