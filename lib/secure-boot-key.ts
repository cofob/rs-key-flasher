import { secp256k1 } from "@noble/curves/secp256k1.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const SECP256K1_OID = Uint8Array.of(0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a);

export interface SecureBootKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  fingerprint: string;
  mnemonic: string;
  pem: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sec1Pem(privateKey: Uint8Array, publicKey: Uint8Array): string {
  const body = concat(
    Uint8Array.of(0x02, 0x01, 0x01),
    Uint8Array.of(0x04, 0x20), privateKey,
    Uint8Array.of(0xa0, SECP256K1_OID.length), SECP256K1_OID,
    Uint8Array.of(0xa1, 0x44, 0x03, 0x42, 0x00, 0x04), publicKey,
  );
  const der = concat(Uint8Array.of(0x30, body.length), body);
  const encoded = base64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN EC PRIVATE KEY-----\n${encoded}\n-----END EC PRIVATE KEY-----\n`;
}

function readLength(der: Uint8Array, offset: number): [number, number] {
  const first = der[offset];
  if (first === undefined) throw new Error("Invalid SEC1 PEM length.");
  if (!(first & 0x80)) return [first, offset + 1];
  const count = first & 0x7f;
  if (!count || count > 2 || offset + count >= der.length) throw new Error("Invalid SEC1 PEM length.");
  let length = 0;
  for (let index = 0; index < count; index++) length = (length << 8) | der[offset + 1 + index];
  return [length, offset + 1 + count];
}

function readElement(der: Uint8Array, offset: number, tag: number): [Uint8Array, number] {
  if (der[offset] !== tag) throw new Error("Unsupported SEC1 PEM structure.");
  const [length, start] = readLength(der, offset + 1);
  const end = start + length;
  if (end > der.length) throw new Error("Truncated SEC1 PEM.");
  return [der.slice(start, end), end];
}

function privateKeyFromPem(pem: string): Uint8Array {
  const match = pem.trim().match(/^-----BEGIN EC PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END EC PRIVATE KEY-----$/);
  if (!match) throw new Error("Use an unencrypted SEC1 EC PRIVATE KEY PEM file.");
  const der = unbase64(match[1].replace(/\s/g, ""));
  const [sequence, sequenceEnd] = readElement(der, 0, 0x30);
  if (sequenceEnd !== der.length) throw new Error("Unexpected data after the SEC1 key.");
  const [version, versionEnd] = readElement(sequence, 0, 0x02);
  if (version.length !== 1 || version[0] !== 1) throw new Error("Unsupported SEC1 key version.");
  const [privateKey, privateEnd] = readElement(sequence, versionEnd, 0x04);
  if (privateKey.length !== 32) throw new Error("The SEC1 private key must be 32 bytes.");
  const parameters = sequence.slice(privateEnd);
  const hasSecp256k1Oid = Array.from({ length: Math.max(0, parameters.length - SECP256K1_OID.length + 1) }, (_, offset) => offset)
    .some((offset) => SECP256K1_OID.every((byte, index) => parameters[offset + index] === byte));
  if (!hasSecp256k1Oid) throw new Error("The SEC1 key must use the secp256k1 named curve.");
  return privateKey;
}

async function fromPrivateKey(privateKey: Uint8Array): Promise<SecureBootKey> {
  const owned = privateKey.slice();
  if (!secp256k1.utils.isValidSecretKey(owned)) throw new Error("The secp256k1 private key is invalid.");
  const encodedPublicKey = secp256k1.getPublicKey(owned, false);
  const publicKey = encodedPublicKey.slice(1);
  const fingerprint = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
  return {
    privateKey: owned,
    publicKey,
    fingerprint,
    mnemonic: entropyToMnemonic(owned, wordlist),
    pem: sec1Pem(owned, publicKey),
  };
}

export async function generateSecureBootKey(): Promise<SecureBootKey> {
  for (;;) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    if (secp256k1.utils.isValidSecretKey(candidate)) return fromPrivateKey(candidate);
    candidate.fill(0);
  }
}

export async function importSecureBootMnemonic(value: string): Promise<SecureBootKey> {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const privateKey = mnemonicToEntropy(normalized, wordlist);
  if (privateKey.length !== 32) throw new Error("Use a 24-word mnemonic for a 256-bit key.");
  return fromPrivateKey(privateKey);
}

export async function importSecureBootPem(value: string): Promise<SecureBootKey> {
  return fromPrivateKey(privateKeyFromPem(value));
}

export function signSecureBootDigest(digest: Uint8Array, key: SecureBootKey): Uint8Array {
  if (digest.length !== 32) throw new Error("A secure-boot digest must be 32 bytes.");
  return secp256k1.sign(digest, key.privateKey, { prehash: false, format: "compact", lowS: true });
}

export function verifySecureBootDigest(
  signature: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  const encoded = publicKey.length === 64 ? concat(Uint8Array.of(0x04), publicKey) : publicKey;
  return secp256k1.verify(signature, digest, encoded, { prehash: false, format: "compact", lowS: false });
}

export function clearSecureBootKey(key: SecureBootKey): void {
  key.privateKey.fill(0);
  key.publicKey.fill(0);
}
