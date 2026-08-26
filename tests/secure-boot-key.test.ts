import { describe, expect, it } from "vitest";
import {
  clearSecureBootKey,
  generateSecureBootKey,
  importSecureBootMnemonic,
  importSecureBootPem,
  signSecureBootDigest,
  verifySecureBootDigest,
} from "../lib/secure-boot-key";

describe("secure-boot signing keys", () => {
  it("round-trips one scalar through SEC1 PEM and a 24-word mnemonic", async () => {
    const generated = await generateSecureBootKey();
    expect(generated.mnemonic.split(" ")).toHaveLength(24);
    expect(generated.pem).toContain("BEGIN EC PRIVATE KEY");

    const fromPem = await importSecureBootPem(generated.pem);
    const fromMnemonic = await importSecureBootMnemonic(generated.mnemonic);
    expect(fromPem.fingerprint).toBe(generated.fingerprint);
    expect(fromMnemonic.fingerprint).toBe(generated.fingerprint);
    expect(fromPem.privateKey).toEqual(generated.privateKey);
    expect(fromMnemonic.privateKey).toEqual(generated.privateKey);
  });

  it("creates a raw secp256k1 signature over a SHA-256 digest", async () => {
    const key = await generateSecureBootKey();
    const digest = new Uint8Array(32).fill(0xa5);
    const signature = signSecureBootDigest(digest, key);
    expect(signature).toHaveLength(64);
    expect(verifySecureBootDigest(signature, digest, key.publicKey)).toBe(true);
    digest[0] ^= 1;
    expect(verifySecureBootDigest(signature, digest, key.publicKey)).toBe(false);
  });

  it("rejects an invalid or non-256-bit mnemonic", async () => {
    await expect(importSecureBootMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"))
      .rejects.toThrow(/24-word/);
  });

  it("clears the in-memory private scalar", async () => {
    const key = await generateSecureBootKey();
    clearSecureBootKey(key);
    expect(key.privateKey.every((byte) => byte === 0)).toBe(true);
  });
});
