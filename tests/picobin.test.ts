import { describe, expect, it } from "vitest";
import { sealUf2 } from "../lib/picobin";
import { generateSecureBootKey } from "../lib/secure-boot-key";
import { contiguousUf2Data, encodeUf2, parseUf2, type Uf2Image } from "../lib/uf2";

function sourceImage(): Uint8Array {
  const data = new Uint8Array(512);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x2002a4a0, true);
  view.setUint32(4, 0x10000081, true);
  view.setUint32(0x100, 0xffffded3, true);
  view.setUint32(0x104, 0x10210142, true);
  view.setUint32(0x108, 0x000001ff, true);
  view.setUint32(0x10c, 0, true);
  view.setUint32(0x110, 0xab123579, true);
  const image: Uf2Image = {
    familyId: 0xe48bff59,
    familyName: "RP2350 Arm Secure",
    productId: 0x000f,
    segments: [{ address: 0x10000000, data }],
    totalBytes: data.length,
  };
  return encodeUf2(image);
}

function findLastMarker(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let found = -1;
  for (let offset = 0; offset + 4 <= data.length; offset += 4) {
    if (view.getUint32(offset, true) === 0xffffded3) found = offset;
  }
  return found;
}

describe("RP2350 picobin sealing", () => {
  it("appends signed metadata and produces a valid UF2", async () => {
    const key = await generateSecureBootKey();
    const sealed = await sealUf2(sourceImage(), key);
    const parsed = parseUf2(sealed.bytes);
    const binary = contiguousUf2Data(parsed).data;
    expect(binary).toHaveLength(768);
    const marker = findLastMarker(binary);
    expect(marker).toBe(512);
    const words = new DataView(binary.buffer, binary.byteOffset + marker, binary.byteLength - marker);
    expect(words.getUint32(4, true) & 0x08000000).not.toBe(0);
    expect(Array.from(binary.slice(marker, marker + 256))).toContain(0x09);
    expect(sealed.signature).toHaveLength(64);
  });

  it("adds rollback rows and ignores the old IMAGE_DEF", async () => {
    const key = await generateSecureBootKey();
    const sealed = await sealUf2(sourceImage(), key, 1);
    const binary = contiguousUf2Data(parseUf2(sealed.bytes)).data;
    expect(binary[0x104]).toBe(0x7e);
    const marker = findLastMarker(binary);
    const metadata = binary.slice(marker, marker + 256);
    const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
    let hasRollback = false;
    for (let offset = 4; offset + 16 <= metadata.length; offset += 4) {
      if ((view.getUint32(offset, true) & 0xff) === 0x48) {
        hasRollback = view.getUint32(offset + 8, true) === 0x004e0001 && view.getUint32(offset + 12, true) === 0x51;
        break;
      }
    }
    expect(hasRollback).toBe(true);
  });

  it("can replace the signature of an already sealed image", async () => {
    const first = await sealUf2(sourceImage(), await generateSecureBootKey());
    const second = await sealUf2(first.bytes, await generateSecureBootKey());
    expect(parseUf2(second.bytes).totalBytes).toBeGreaterThan(parseUf2(first.bytes).totalBytes);
  });
});
