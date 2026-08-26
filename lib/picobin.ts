import { contiguousUf2Data, encodeUf2, parseUf2, type Uf2Image } from "./uf2";
import {
  signSecureBootDigest,
  verifySecureBootDigest,
  type SecureBootKey,
} from "./secure-boot-key";

const BLOCK_START = 0xffffded3;
const BLOCK_END = 0xab123579;
const ITEM_IMAGE_TYPE = 0x42;
const ITEM_VECTOR_TABLE = 0x03;
const ITEM_ENTRY_POINT = 0x44;
const ITEM_LOAD_MAP = 0x06;
const ITEM_HASH_DEF = 0x47;
const ITEM_VERSION = 0x48;
const ITEM_SIGNATURE = 0x09;
const ITEM_PARTITION_TABLE = 0x0a;
const ITEM_HASH_VALUE = 0x4b;
const ITEM_LAST = 0xff;
const IMAGE_TYPE_EXTRA_SECURITY = 0x0800;
const IMAGE_TYPE_TBYB = 0x8000;
const RP2350_ARM_SECURE_FAMILY = 0xe48bff59;
const FLASH_END = 0x11000000;
const ROLLBACK_ROWS = [0x4e, 0x51];

interface ParsedItem {
  address: number;
  type: number;
  words: number[];
}

interface ParsedBlock {
  address: number;
  offset: number;
  nextRelative: number;
  nextWordOffset: number;
  items: ParsedItem[];
}

interface LoadMapEntry {
  storageAddress: number;
  runtimeAddress: number;
  size: number;
}

interface LoadMap {
  absolute: boolean;
  entries: LoadMapEntry[];
}

export interface SealedUf2 {
  bytes: Uint8Array;
  image: Uf2Image;
  digest: Uint8Array;
  signature: Uint8Array;
  rollbackVersion?: number;
}

function fail(message: string): never {
  throw new Error(`Cannot seal UF2: ${message}`);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) fail("truncated picobin metadata");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  if (offset < 0 || offset + 4 > bytes.length) fail("picobin metadata points outside the image");
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function decodeItemSize(header: number): number {
  return header & 0x80 ? (header >>> 8) & 0xffff : (header >>> 8) & 0xff;
}

function wordsToBytes(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));
  return bytes;
}

function bytesToWords(bytes: Uint8Array): number[] {
  if (bytes.length % 4) fail("picobin data is not word aligned");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, index) => view.getUint32(index * 4, true));
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

function parseBlock(bytes: Uint8Array, storageAddress: number, address: number): ParsedBlock {
  const offset = address - storageAddress;
  if (readU32(bytes, offset) !== BLOCK_START) fail(`no metadata block at 0x${address.toString(16)}`);

  const items: ParsedItem[] = [];
  const itemStart = offset + 4;
  let cursor = itemStart;
  for (let count = 0; count < 256; count++) {
    const header = readU32(bytes, cursor);
    const type = header & 0xff;
    const size = decodeItemSize(header);
    if (!size) fail(`zero-sized metadata item at 0x${(storageAddress + cursor).toString(16)}`);
    if (type === ITEM_LAST) {
      if (size !== (cursor - itemStart) / 4 || readU32(bytes, cursor + 8) !== BLOCK_END) {
        fail(`invalid metadata block at 0x${address.toString(16)}`);
      }
      return {
        address,
        offset,
        nextRelative: readU32(bytes, cursor + 4),
        nextWordOffset: (cursor + 4 - offset) / 4,
        items,
      };
    }
    const end = cursor + size * 4;
    if (end > bytes.length) fail("metadata item extends past the image");
    items.push({
      address: (storageAddress + cursor) >>> 0,
      type,
      words: bytesToWords(bytes.subarray(cursor, end)),
    });
    cursor = end;
  }
  fail("metadata block contains too many items");
}

function findFirstBlock(bytes: Uint8Array, storageAddress: number): ParsedBlock {
  for (let offset = 0; offset + 16 <= bytes.length; offset += 4) {
    if (readU32(bytes, offset) !== BLOCK_START) continue;
    try {
      return parseBlock(bytes, storageAddress, (storageAddress + offset) >>> 0);
    } catch {
      // A marker can occur in firmware data. Continue until a complete block is found.
    }
  }
  fail("the image has no valid picobin metadata block");
}

function blockLoop(bytes: Uint8Array, storageAddress: number, first: ParsedBlock): ParsedBlock[] {
  const blocks = [first];
  if (!first.nextRelative) return blocks;
  let address = (first.address + first.nextRelative) >>> 0;
  const seen = new Set([first.address]);
  for (let count = 0; count < 32; count++) {
    if (address === first.address) return blocks;
    if (seen.has(address)) fail("metadata block loop does not return to its first block");
    seen.add(address);
    const block = parseBlock(bytes, storageAddress, address);
    blocks.push(block);
    address = (block.address + block.nextRelative) >>> 0;
  }
  fail("metadata block loop is too long");
}

function decodeLoadMap(item: ParsedItem): LoadMap {
  const header = item.words[0];
  const count = (header >>> 24) & 0x7f;
  const absolute = Boolean(header & 0x80000000);
  if (item.words.length !== 1 + count * 3) fail("invalid load map size");
  const entries: LoadMapEntry[] = [];
  for (let index = 0; index < count; index++) {
    const rawStorage = item.words[1 + index * 3];
    const runtimeAddress = item.words[2 + index * 3];
    const rawSize = item.words[3 + index * 3];
    entries.push({
      storageAddress: rawStorage === 0 ? 0 : absolute ? rawStorage : (rawStorage + item.address) >>> 0,
      runtimeAddress,
      size: rawStorage !== 0 && absolute ? (rawSize - runtimeAddress) >>> 0 : rawSize,
    });
  }
  return { absolute, entries };
}

function encodeLoadMap(loadMap: LoadMap, blockAddress: number, wordOffset: number): number[] {
  const words = [
    ((1 + loadMap.entries.length * 3) << 8) |
      ITEM_LOAD_MAP |
      (loadMap.entries.length << 24) |
      (loadMap.absolute ? 0x80000000 : 0),
  ];
  for (const entry of loadMap.entries) {
    words.push(entry.storageAddress === 0
      ? 0
      : loadMap.absolute
        ? entry.storageAddress
        : (entry.storageAddress - blockAddress - wordOffset * 4) >>> 0);
    words.push(entry.runtimeAddress);
    words.push(loadMap.absolute && entry.storageAddress !== 0
      ? (entry.runtimeAddress + entry.size) >>> 0
      : entry.size);
  }
  return words;
}

function versionItem(major: number, minor: number, rollback: number): ParsedItem {
  return {
    address: 0,
    type: ITEM_VERSION,
    words: [
      (ROLLBACK_ROWS.length << 24) | (4 << 8) | ITEM_VERSION,
      ((major & 0xffff) << 16) | (minor & 0xffff),
      ((ROLLBACK_ROWS[0] & 0xffff) << 16) | (rollback & 0xffff),
      ROLLBACK_ROWS[1],
    ],
  };
}

function simpleItem(type: number, words: number[]): ParsedItem {
  return { address: 0, type, words };
}

function serializeBlock(items: ParsedItem[], address: number, nextRelative: number): Uint8Array {
  const words = [BLOCK_START];
  for (const item of items) {
    if (item.type === ITEM_LOAD_MAP) {
      words.push(...encodeLoadMap(decodeLoadMap(item), address, words.length));
    } else if (item.type === ITEM_HASH_DEF && item.words.length === 2) {
      words.push(item.words[0], words.length + 2);
    } else {
      words.push(...item.words);
    }
  }
  if (words.length > 0x17d) fail("signed image metadata is too large");
  words.push(((words.length - 1) << 8) | ITEM_LAST, nextRelative >>> 0, BLOCK_END);
  return wordsToBytes(words);
}

function hashInputForLoadMap(
  bytes: Uint8Array,
  storageAddress: number,
  loadMap: LoadMap,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of loadMap.entries) {
    if (entry.storageAddress === 0) {
      parts.push(wordsToBytes([entry.size]));
      continue;
    }
    const offset = entry.storageAddress - storageAddress;
    if (offset < 0 || offset + entry.size > bytes.length) {
      fail(`load map range 0x${entry.storageAddress.toString(16)} is outside the UF2 image`);
    }
    parts.push(bytes.slice(offset, offset + entry.size));
  }
  return concat(...parts);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = bytes.slice();
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
}

function signatureItem(publicKey: Uint8Array, signature: Uint8Array): ParsedItem {
  if (publicKey.length !== 64 || signature.length !== 64) fail("invalid secp256k1 key or signature size");
  return simpleItem(
    ITEM_SIGNATURE,
    [0x01002109, ...bytesToWords(publicKey), ...bytesToWords(signature)],
  );
}

export async function sealUf2(
  source: Uint8Array,
  key: SecureBootKey,
  rollbackVersion?: number,
): Promise<SealedUf2> {
  if (rollbackVersion !== undefined && (!Number.isInteger(rollbackVersion) || rollbackVersion < 1 || rollbackVersion > 48)) {
    fail("rollback version must be an integer from 1 to 48");
  }

  const parsed = parseUf2(source);
  if (parsed.familyId !== RP2350_ARM_SECURE_FAMILY) fail("only RP2350 Arm Secure UF2 images can be sealed");
  const contiguous = contiguousUf2Data(parsed);
  if (contiguous.address !== 0x10000000 || contiguous.data.length % 256) {
    fail("the RP2350 flash image must start at 0x10000000 and use 256-byte alignment");
  }
  const bytes = contiguous.data;
  const newBlockAddress = (contiguous.address + bytes.length) >>> 0;
  if (newBlockAddress >= FLASH_END) fail("there is no flash space for signed metadata");

  const first = findFirstBlock(bytes, contiguous.address);
  const blocks = blockLoop(bytes, contiguous.address, first);
  const last = blocks.at(-1)!;
  const sourceBlock = last.items.some((item) => item.type === ITEM_IMAGE_TYPE) ? last : first;
  let items = sourceBlock.items
    .filter((item) => ![ITEM_HASH_DEF, ITEM_HASH_VALUE, ITEM_SIGNATURE].includes(item.type))
    .map((item) => ({ ...item, words: [...item.words] }));

  const imageType = items.find((item) => item.type === ITEM_IMAGE_TYPE);
  if (!imageType || imageType !== items[0]) fail("the bootable metadata block has no leading IMAGE_TYPE item");
  const imageFlags = imageType.words[0] >>> 16;
  if ((imageFlags & 0x0f) !== 1 || (imageFlags & 0x0700) !== 0 || (imageFlags & 0x7000) !== 0x1000) {
    fail("the UF2 does not contain an RP2350 Arm executable image");
  }
  imageType.words[0] = (imageType.words[0] | (IMAGE_TYPE_EXTRA_SECURITY << 16)) >>> 0;

  if (rollbackVersion !== undefined) {
    let major = 0;
    let minor = 0;
    const oldVersion = items.find((item) => item.type === ITEM_VERSION);
    if (oldVersion && oldVersion.words.length >= 2) {
      major = oldVersion.words[1] >>> 16;
      minor = oldVersion.words[1] & 0xffff;
    }
    items = items.filter((item) => item.type !== ITEM_VERSION);
    items.push(versionItem(major, minor, rollbackVersion));
  }

  if (!items.some((item) => item.type === ITEM_ENTRY_POINT)) {
    if (!items.some((item) => item.type === ITEM_VECTOR_TABLE)) {
      items.push(simpleItem(ITEM_VECTOR_TABLE, [(2 << 8) | ITEM_VECTOR_TABLE, contiguous.address]));
    }
    const stackPointer = readU32(bytes, 0);
    const entryPoint = readU32(bytes, 4);
    items.push(simpleItem(ITEM_ENTRY_POINT, [(3 << 8) | ITEM_ENTRY_POINT, entryPoint, stackPointer]));
  }

  let loadMapItem = items.find((item) => item.type === ITEM_LOAD_MAP);
  if (!loadMapItem) {
    const itemAddress = newBlockAddress + 4 + items.reduce((size, item) => size + item.words.length * 4, 0);
    loadMapItem = simpleItem(ITEM_LOAD_MAP, [
      0x01000406,
      (contiguous.address - itemAddress) >>> 0,
      contiguous.address,
      bytes.length,
    ]);
    loadMapItem.address = itemAddress;
    items.push(loadMapItem);
  }

  const linkOwner = first.nextRelative ? last : first;
  writeU32(bytes, linkOwner.offset + linkOwner.nextWordOffset * 4, newBlockAddress - linkOwner.address);
  if (rollbackVersion !== undefined) {
    for (const block of blocks) {
      const firstItem = block.items[0];
      if (firstItem && (firstItem.type & 0x7f) !== ITEM_PARTITION_TABLE) bytes[block.offset + 4] = 0x7e;
    }
  }

  const loadMap = decodeLoadMap(loadMapItem);
  if (loadMapItem.address === 0) {
    loadMapItem.address = newBlockAddress + 4 + items
      .slice(0, items.indexOf(loadMapItem))
      .reduce((size, item) => size + item.words.length * 4, 0);
  }
  const mappedData = sourceBlock.items.some((item) => item.type === ITEM_LOAD_MAP)
    ? hashInputForLoadMap(bytes, contiguous.address, loadMap)
    : bytes.slice();

  items.push(simpleItem(ITEM_HASH_DEF, [0x01000247, 0]));
  const nextRelative = (first.address - newBlockAddress) >>> 0;
  const unsignedBlock = serializeBlock(items, newBlockAddress, nextRelative);
  const metadataForHash = unsignedBlock.slice(0, unsignedBlock.length - 12);
  if (imageFlags & IMAGE_TYPE_TBYB) {
    writeU32(metadataForHash, 4, readU32(metadataForHash, 4) & 0x7fffffff);
  }
  const digest = await sha256(concat(mappedData, metadataForHash));
  const signature = signSecureBootDigest(digest, key);
  if (!verifySecureBootDigest(signature, digest, key.publicKey)) fail("generated signature did not verify");

  items.push(signatureItem(key.publicKey, signature));
  const finalBlock = serializeBlock(items, newBlockAddress, nextRelative);
  const binarySize = Math.ceil((bytes.length + finalBlock.length) / 256) * 256;
  if (contiguous.address + binarySize > FLASH_END) fail("signed metadata exceeds RP2350 flash address space");
  const signedBinary = new Uint8Array(binarySize);
  signedBinary.set(bytes);
  signedBinary.set(finalBlock, bytes.length);
  const image: Uf2Image = {
    ...parsed,
    segments: [{ address: contiguous.address, data: signedBinary }],
    totalBytes: signedBinary.length,
  };
  return {
    bytes: encodeUf2(image),
    image,
    digest,
    signature,
    rollbackVersion,
  };
}
