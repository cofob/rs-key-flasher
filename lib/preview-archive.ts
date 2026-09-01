import { PREVIEW_VARIANTS, previewAssetFilename, type PreviewArchiveStorage } from "./previews";

const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_OUTPUT_SIZE = 100 * 1024 * 1024;
const MAX_MEMBER_SIZE = 32 * 1024 * 1024;
const EXPECTED_NAMES = new Set(PREVIEW_VARIANTS.map(previewAssetFilename));

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function tarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  const field = bytes.subarray(0, end < 0 ? bytes.byteLength : end);
  if (field.some((byte) => byte > 0x7f || byte < 0x20)) throw new Error("The TAR archive has an invalid text field.");
  return new TextDecoder().decode(field);
}

function tarNumber(bytes: Uint8Array): number {
  const value = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("The TAR archive has an invalid numeric field.");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error("The TAR archive has an unsafe numeric field.");
  return result;
}

function parseHeader(header: Uint8Array): { name: string; size: number } | null {
  if (header.every((byte) => byte === 0)) return null;
  const storedChecksum = tarNumber(header.subarray(148, 156));
  let checksum = 0;
  for (let index = 0; index < header.byteLength; index++) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (checksum !== storedChecksum) throw new Error("The TAR header checksum is invalid.");

  const name = tarText(header.subarray(0, 100));
  const prefix = tarText(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  const type = header[156];
  if (type !== 0 && type !== 0x30) throw new Error("The TAR archive contains a non-file entry.");
  if (!EXPECTED_NAMES.has(path)) throw new Error("The TAR archive contains an unsafe file name.");
  const size = tarNumber(header.subarray(124, 136));
  if (size > MAX_MEMBER_SIZE) throw new Error("A TAR member is too large.");
  return { name: path, size };
}

export async function extractPreviewTarMember(
  stream: ReadableStream<Uint8Array>,
  memberName: string,
  expectedSize: number,
  expectedUncompressedSize: number,
  onProgress: (value: number) => void = () => {},
): Promise<Uint8Array> {
  if (!EXPECTED_NAMES.has(memberName) || expectedSize <= 0 || expectedSize > MAX_MEMBER_SIZE ||
      expectedUncompressedSize <= 0 || expectedUncompressedSize > MAX_ARCHIVE_OUTPUT_SIZE) {
    throw new Error("The preview archive metadata is invalid.");
  }

  const output = new Uint8Array(expectedSize);
  const names = new Set<string>();
  const reader = stream.getReader();
  let pending: Uint8Array = new Uint8Array();
  let totalBytes = 0;
  let contentBytes = 0;
  let selectedOffset = 0;
  let ended = false;
  let current: { name: string; remaining: number; padding: number } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ARCHIVE_OUTPUT_SIZE) throw new Error("The TAR archive is too large.");
    pending = append(pending, value);
    onProgress(Math.min(1, contentBytes / expectedUncompressedSize));

    while (pending.byteLength) {
      if (ended) {
        if (pending.some((byte) => byte !== 0)) throw new Error("The TAR archive has data after its end marker.");
        pending = new Uint8Array();
        break;
      }
      if (!current) {
        if (pending.byteLength < TAR_BLOCK_SIZE) break;
        const parsed = parseHeader(pending.subarray(0, TAR_BLOCK_SIZE));
        pending = pending.slice(TAR_BLOCK_SIZE);
        if (!parsed) {
          ended = true;
          continue;
        }
        if (names.has(parsed.name)) throw new Error("The TAR archive contains a duplicate member.");
        names.add(parsed.name);
        contentBytes += parsed.size;
        if (contentBytes > expectedUncompressedSize) throw new Error("The TAR content is larger than its metadata.");
        if (parsed.name === memberName && parsed.size !== expectedSize) {
          throw new Error("The firmware size does not match the TAR metadata.");
        }
        current = {
          name: parsed.name,
          remaining: parsed.size,
          padding: (TAR_BLOCK_SIZE - (parsed.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE,
        };
      }
      if (current.remaining > 0) {
        if (!pending.byteLength) break;
        const count = Math.min(current.remaining, pending.byteLength);
        if (current.name === memberName) {
          output.set(pending.subarray(0, count), selectedOffset);
          selectedOffset += count;
        }
        pending = pending.slice(count);
        current.remaining -= count;
        if (current.remaining > 0) break;
      }
      if (current.padding > 0) {
        if (pending.byteLength < current.padding) break;
        if (pending.subarray(0, current.padding).some((byte) => byte !== 0)) {
          throw new Error("The TAR member padding is invalid.");
        }
        pending = pending.slice(current.padding);
      }
      current = null;
    }
  }

  if (!ended || current || pending.byteLength || contentBytes !== expectedUncompressedSize ||
      names.size !== EXPECTED_NAMES.size || [...EXPECTED_NAMES].some((name) => !names.has(name)) ||
      selectedOffset !== expectedSize) {
    throw new Error("The TAR archive is incomplete.");
  }
  onProgress(1);
  return output;
}

function zstdStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const Decompression = globalThis.DecompressionStream as unknown as
    (new (format: string) => TransformStream<Uint8Array, Uint8Array>) | undefined;
  if (!Decompression) throw new Error("Native Zstandard decompression is not available.");
  return new Blob([bytes.slice()]).stream().pipeThrough(new Decompression("zstd"));
}

export async function extractPreviewArchive(
  bytes: Uint8Array,
  storage: PreviewArchiveStorage,
  memberName: string,
  expectedSize: number,
  onProgress: (value: number) => void = () => {},
  forceWasm = false,
): Promise<Uint8Array> {
  if (!forceWasm) {
    try {
      return await extractPreviewTarMember(
        zstdStream(bytes),
        memberName,
        expectedSize,
        storage.uncompressedSize,
        onProgress,
      );
    } catch {
      // Use the same bounded parser in Rust when native Zstandard support fails.
    }
  }

  const wasm = await import("./wasm/generated/preview_archive.js");
  await wasm.default();
  const output = wasm.extract_preview_member(
    bytes,
    memberName,
    expectedSize,
    storage.uncompressedSize,
  );
  onProgress(1);
  return output;
}
