const BLOCK_SIZE = 512;
const MAGIC_START_0 = 0x0a324655;
const MAGIC_START_1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_NO_FLASH = 0x00000001;
const FLAG_FAMILY_ID = 0x00002000;
const XIP_START = 0x10000000;
const XIP_END = 0x11000000;

export const RP2_FAMILIES = {
  0xe48bff56: { name: "RP2040", productId: 0x0003 },
  0xe48bff59: { name: "RP2350 Arm Secure", productId: 0x000f },
  0xe48bff5a: { name: "RP2350 RISC-V", productId: 0x000f },
  0xe48bff5b: { name: "RP2350 Arm Non-secure", productId: 0x000f },
} as const;

export type Rp2FamilyId = keyof typeof RP2_FAMILIES;

export interface Uf2Segment {
  address: number;
  data: Uint8Array;
}

export interface Uf2Image {
  familyId: Rp2FamilyId;
  familyName: string;
  productId: number;
  segments: Uf2Segment[];
  totalBytes: number;
}

interface ParsedBlock {
  address: number;
  data: Uint8Array;
}

function fail(message: string): never {
  throw new Error(`Invalid UF2: ${message}`);
}

export function parseUf2(bytes: Uint8Array): Uf2Image {
  if (!bytes.length || bytes.length % BLOCK_SIZE !== 0) fail("file size is not a multiple of 512 bytes");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set<number>();
  const blocks: ParsedBlock[] = [];
  let expectedBlocks: number | undefined;
  let familyId: number | undefined;

  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    if (view.getUint32(offset, true) !== MAGIC_START_0 ||
        view.getUint32(offset + 4, true) !== MAGIC_START_1 ||
        view.getUint32(offset + 508, true) !== MAGIC_END) {
      fail(`bad magic in block ${offset / BLOCK_SIZE}`);
    }

    const flags = view.getUint32(offset + 8, true);
    const address = view.getUint32(offset + 12, true);
    const payloadSize = view.getUint32(offset + 16, true);
    const blockNumber = view.getUint32(offset + 20, true);
    const blockCount = view.getUint32(offset + 24, true);

    if (expectedBlocks === undefined) expectedBlocks = blockCount;
    if (!blockCount || blockCount !== expectedBlocks || blockNumber >= blockCount || seen.has(blockNumber)) {
      fail("inconsistent or duplicate block numbers");
    }
    seen.add(blockNumber);

    if (flags & FLAG_FAMILY_ID) {
      const currentFamily = view.getUint32(offset + 28, true);
      if (familyId !== undefined && familyId !== currentFamily) fail("mixed target families");
      familyId = currentFamily;
    }

    if (flags & FLAG_NO_FLASH) continue;
    if (payloadSize === 0 || payloadSize > 476 || payloadSize % 256 !== 0 || address % 256 !== 0) {
      fail(`unsupported payload alignment in block ${blockNumber}`);
    }
    if (address < XIP_START || address + payloadSize > XIP_END) fail("target address is outside RP2 flash");

    blocks.push({
      address,
      data: bytes.slice(offset + 32, offset + 32 + payloadSize),
    });
  }

  if (seen.size !== expectedBlocks) fail("one or more blocks are missing");
  if (familyId === undefined || !(familyId in RP2_FAMILIES)) fail("unsupported or missing RP2 family ID");
  if (!blocks.length) fail("image contains no flash data");

  blocks.sort((a, b) => a.address - b.address);
  const segments: Uf2Segment[] = [];
  for (const block of blocks) {
    const previous = segments.at(-1);
    if (previous && block.address < previous.address + previous.data.length) fail("overlapping flash blocks");
    if (previous && block.address === previous.address + previous.data.length) {
      const data = new Uint8Array(previous.data.length + block.data.length);
      data.set(previous.data);
      data.set(block.data, previous.data.length);
      previous.data = data;
    } else {
      segments.push({ address: block.address, data: block.data });
    }
  }

  const family = RP2_FAMILIES[familyId as Rp2FamilyId];
  return {
    familyId: familyId as Rp2FamilyId,
    familyName: family.name,
    productId: family.productId,
    segments,
    totalBytes: segments.reduce((sum, segment) => sum + segment.data.length, 0),
  };
}

export function eraseRanges(image: Uf2Image): Array<{ address: number; size: number }> {
  const sector = 4096;
  const ranges = image.segments.map((segment) => ({
    address: segment.address & ~(sector - 1),
    end: (segment.address + segment.data.length + sector - 1) & ~(sector - 1),
  }));

  const merged: Array<{ address: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.address <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged.map(({ address, end }) => ({ address, size: end - address }));
}
