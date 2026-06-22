import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

/**
 * Ed25519 helpers for the HTTP Interactions Endpoint flow. The emulator signs each
 * delivery with the application's private key; apps verify with the public key (published
 * as 32-byte hex, exactly what Discord shows in the dev portal).
 */

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Ed25519KeyPair {
  /** Raw 32-byte public key as hex (the "Public Key" apps paste into their verifier). */
  publicKeyHex: string;
  /** PKCS#8 PEM private key. */
  privateKeyPem: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyHex: ed25519PublicKeyToHex(publicKey),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function ed25519PublicKeyToHex(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("hex");
}

export function ed25519PublicKeyFromHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, "hex");
  const der = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Sign `timestamp + body` (raw request bytes) with the app private key; returns hex. */
export function signInteraction(timestamp: string, body: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(timestamp + body), key);
  return signature.toString("hex");
}

/** Verify an Ed25519 interaction signature (used by tests and the inbound endpoint check). */
export function verifyInteraction(
  timestamp: string,
  body: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const pub = ed25519PublicKeyFromHex(publicKeyHex);
    return verify(null, Buffer.from(timestamp + body), pub, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
