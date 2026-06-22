import { createDeflate, constants, type Deflate } from "node:zlib";

/**
 * Per-connection zlib-stream compressor for the Gateway. Discord (and discord.py by
 * default) use a single shared zlib context for the whole connection, flushing each
 * message with Z_SYNC_FLUSH so every compressed payload ends with the `00 00 ff ff`
 * marker. The client inflates with a single matching context.
 *
 * Calls are serialized through an internal promise chain because the deflate stream is
 * stateful and must process one message at a time, in order.
 */
export class ZlibCompressor {
  private readonly deflate: Deflate;
  private chunks: Buffer[] = [];
  private queue: Promise<Buffer> = Promise.resolve(Buffer.alloc(0));

  constructor() {
    this.deflate = createDeflate();
    this.deflate.on("data", (chunk: Buffer) => this.chunks.push(chunk));
  }

  compress(data: string | Buffer): Promise<Buffer> {
    this.queue = this.queue.then(
      () =>
        new Promise<Buffer>((resolve) => {
          this.deflate.write(data, () => {
            this.deflate.flush(constants.Z_SYNC_FLUSH, () => {
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
      this.deflate.close();
    } catch {
      // ignore
    }
  }
}
