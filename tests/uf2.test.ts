import { describe, expect, it } from "vitest";
import { encodeUf2, eraseRanges, parseUf2 } from "../lib/uf2";

function uf2Block(block: number, count: number, address: number, family = 0xe48bff59): Uint8Array {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x0a324655, true);
  view.setUint32(4, 0x9e5d5157, true);
  view.setUint32(8, 0x2000, true);
  view.setUint32(12, address, true);
  view.setUint32(16, 256, true);
  view.setUint32(20, block, true);
  view.setUint32(24, count, true);
  view.setUint32(28, family, true);
  bytes.fill(block + 1, 32, 288);
  view.setUint32(508, 0x0ab16f30, true);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("UF2 parser", () => {
  it("joins contiguous blocks and identifies RP2350", () => {
    const image = parseUf2(join(
      uf2Block(1, 2, 0x10000100),
      uf2Block(0, 2, 0x10000000),
    ));
    expect(image.familyName).toBe("RP2350 Arm Secure");
    expect(image.productId).toBe(0x000f);
    expect(image.segments).toHaveLength(1);
    expect(image.segments[0].data).toHaveLength(512);
  });

  it("rejects a legacy RP2 family image", () => {
    expect(() => parseUf2(uf2Block(0, 1, 0x10000000, 0xe48bff56))).toThrow(/unsupported/);
  });

  it("merges sector-aligned erase ranges", () => {
    const image = parseUf2(join(
      uf2Block(0, 2, 0x10000000),
      uf2Block(1, 2, 0x10001000),
    ));
    expect(eraseRanges(image)).toEqual([{ address: 0x10000000, size: 0x2000 }]);
  });

  it("encodes a parsed image without changing its flash bytes", () => {
    const source = join(
      uf2Block(0, 2, 0x10000000),
      uf2Block(1, 2, 0x10000100),
    );
    const parsed = parseUf2(source);
    expect(parseUf2(encodeUf2(parsed)).segments).toEqual(parsed.segments);
  });

  it("rejects corrupt and unsupported images", () => {
    const corrupt = uf2Block(0, 1, 0x10000000);
    corrupt[0] = 0;
    expect(() => parseUf2(corrupt)).toThrow(/bad magic/);
    expect(() => parseUf2(uf2Block(0, 1, 0x10000000, 1))).toThrow(/unsupported/);
  });
});
