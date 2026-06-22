/**
 * Minimal ETF (Erlang External Term Format) codec for the Gateway `encoding=etf` path.
 *
 * Discord clients that select ETF use the `erlpack` wire format: a 0x83 version byte
 * followed by a single term. This implements the subset that the Gateway actually
 * exchanges — integers, floats, the `true`/`false`/`nil` atoms, UTF-8 binaries (strings),
 * lists and maps (with binary keys) — which is everything `pack`/`unpack` need for
 * IDENTIFY/RESUME/HEARTBEAT in and dispatch/Hello out. It is not a general-purpose Erlang
 * term implementation; tuples, pids, refs and the like are not produced and are skipped on
 * decode where structurally possible.
 */

const VERSION = 131;

// Term tags.
const SMALL_INTEGER_EXT = 97; // a
const INTEGER_EXT = 98; // b
const FLOAT_EXT = 99; // c (legacy 31-byte ASCII float)
const ATOM_EXT = 100; // d
const SMALL_TUPLE_EXT = 104; // h
const LARGE_TUPLE_EXT = 105; // i
const NIL_EXT = 106; // j
const STRING_EXT = 107; // k (list of bytes)
const LIST_EXT = 108; // l
const BINARY_EXT = 109; // m
const SMALL_BIG_EXT = 110; // n
const LARGE_BIG_EXT = 111; // o
const SMALL_ATOM_EXT = 115; // s
const MAP_EXT = 116; // t
const ATOM_UTF8_EXT = 118; // v
const SMALL_ATOM_UTF8_EXT = 119; // w
const NEW_FLOAT_EXT = 70; // F

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

class Writer {
  private parts: Buffer[] = [];
  private size = 0;

  byte(n: number): void {
    this.push(Buffer.from([n & 0xff]));
  }

  push(buf: Buffer): void {
    this.parts.push(buf);
    this.size += buf.length;
  }

  finish(): Buffer {
    return Buffer.concat(this.parts, this.size);
  }
}

function writeAtom(w: Writer, name: string): void {
  const bytes = Buffer.from(name, "utf8");
  w.byte(SMALL_ATOM_UTF8_EXT);
  w.byte(bytes.length);
  w.push(bytes);
}

function writeBinary(w: Writer, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(BINARY_EXT, 0);
  header.writeUInt32BE(bytes.length, 1);
  w.push(header);
  w.push(bytes);
}

function writeInteger(w: Writer, value: number): void {
  if (value >= 0 && value <= 255) {
    w.byte(SMALL_INTEGER_EXT);
    w.byte(value);
    return;
  }
  if (value >= INT32_MIN && value <= INT32_MAX) {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(INTEGER_EXT, 0);
    buf.writeInt32BE(value, 1);
    w.push(buf);
    return;
  }
  writeBigInt(w, BigInt(value));
}

function writeBigInt(w: Writer, value: bigint): void {
  const sign = value < 0n ? 1 : 0;
  let n = value < 0n ? -value : value;
  const digits: number[] = [];
  while (n > 0n) {
    digits.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if (digits.length === 0) digits.push(0);
  w.byte(SMALL_BIG_EXT);
  w.byte(digits.length);
  w.byte(sign);
  w.push(Buffer.from(digits));
}

function writeFloat(w: Writer, value: number): void {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(NEW_FLOAT_EXT, 0);
  buf.writeDoubleBE(value, 1);
  w.push(buf);
}

function writeTerm(w: Writer, value: unknown): void {
  if (value === null || value === undefined) {
    writeAtom(w, "nil");
    return;
  }
  switch (typeof value) {
    case "boolean":
      writeAtom(w, value ? "true" : "false");
      return;
    case "string":
      writeBinary(w, value);
      return;
    case "bigint":
      writeBigInt(w, value);
      return;
    case "number":
      if (Number.isInteger(value)) writeInteger(w, value);
      else writeFloat(w, value);
      return;
    case "object":
      break;
    default:
      writeAtom(w, "nil");
      return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      w.byte(NIL_EXT);
      return;
    }
    const header = Buffer.alloc(5);
    header.writeUInt8(LIST_EXT, 0);
    header.writeUInt32BE(value.length, 1);
    w.push(header);
    for (const item of value) writeTerm(w, item);
    w.byte(NIL_EXT); // improper-list tail terminator
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const header = Buffer.alloc(5);
  header.writeUInt8(MAP_EXT, 0);
  header.writeUInt32BE(entries.length, 1);
  w.push(header);
  for (const [key, v] of entries) {
    writeBinary(w, key);
    writeTerm(w, v);
  }
}

/** Encode a value as a versioned ETF term (erlpack-compatible). */
export function packETF(value: unknown): Buffer {
  const w = new Writer();
  w.byte(VERSION);
  writeTerm(w, value);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    return this.buf.readUInt8(this.offset++);
  }

  u16(): number {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  slice(n: number): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
}

function atomValue(name: string): unknown {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "nil" || name === "null" || name === "undefined") return null;
  return name;
}

function readBig(r: Reader, digitsLen: number): number | bigint {
  const sign = r.u8();
  let value = 0n;
  let factor = 1n;
  for (let i = 0; i < digitsLen; i++) {
    value += BigInt(r.u8()) * factor;
    factor <<= 8n;
  }
  if (sign === 1) value = -value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function readTerm(r: Reader): unknown {
  const tag = r.u8();
  switch (tag) {
    case SMALL_INTEGER_EXT:
      return r.u8();
    case INTEGER_EXT:
      return r.i32();
    case NEW_FLOAT_EXT:
      return r.f64();
    case FLOAT_EXT:
      return Number.parseFloat(r.slice(31).toString("latin1"));
    case SMALL_BIG_EXT:
      return readBig(r, r.u8());
    case LARGE_BIG_EXT:
      return readBig(r, r.u32());
    case ATOM_EXT:
    case ATOM_UTF8_EXT:
      return atomValue(r.slice(r.u16()).toString("utf8"));
    case SMALL_ATOM_EXT:
    case SMALL_ATOM_UTF8_EXT:
      return atomValue(r.slice(r.u8()).toString("utf8"));
    case BINARY_EXT:
      return r.slice(r.u32()).toString("utf8");
    case STRING_EXT: {
      // A list of byte-sized integers.
      const len = r.u16();
      return Array.from(r.slice(len));
    }
    case NIL_EXT:
      return [];
    case LIST_EXT: {
      const count = r.u32();
      const list: unknown[] = [];
      for (let i = 0; i < count; i++) list.push(readTerm(r));
      r.u8(); // tail (NIL_EXT for proper lists)
      return list;
    }
    case SMALL_TUPLE_EXT: {
      const count = r.u8();
      const tuple: unknown[] = [];
      for (let i = 0; i < count; i++) tuple.push(readTerm(r));
      return tuple;
    }
    case LARGE_TUPLE_EXT: {
      const count = r.u32();
      const tuple: unknown[] = [];
      for (let i = 0; i < count; i++) tuple.push(readTerm(r));
      return tuple;
    }
    case MAP_EXT: {
      const arity = r.u32();
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < arity; i++) {
        const key = readTerm(r);
        const value = readTerm(r);
        obj[String(key)] = value;
      }
      return obj;
    }
    default:
      throw new Error(`Unsupported ETF tag: ${tag}`);
  }
}

/** Decode a versioned ETF term (erlpack-compatible) into a plain JS value. */
export function unpackETF(buf: Buffer): unknown {
  const r = new Reader(buf);
  const version = r.u8();
  if (version !== VERSION) throw new Error(`Unsupported ETF version: ${version}`);
  return readTerm(r);
}
