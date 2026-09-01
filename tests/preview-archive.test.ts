import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractPreviewArchive, extractPreviewTarMember } from "../lib/preview-archive";
import { PREVIEW_VARIANTS, previewAssetFilename } from "../lib/previews";
import initializeWasm from "../lib/wasm/generated/preview_archive.js";

const encoder = new TextEncoder();

function writeText(output: Uint8Array, offset: number, length: number, value: string): void {
  output.set(encoder.encode(value).subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeText(header, 0, 100, name);
  writeText(header, 100, 8, octal(0o644, 8));
  writeText(header, 108, 8, octal(0, 8));
  writeText(header, 116, 8, octal(0, 8));
  writeText(header, 124, 12, octal(size, 12));
  writeText(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tarArchive(changeName?: (name: string, index: number) => string): {
  bytes: Uint8Array;
  contents: Map<string, Uint8Array>;
  contentSize: number;
} {
  const parts: Uint8Array[] = [];
  const contents = new Map<string, Uint8Array>();
  let contentSize = 0;
  PREVIEW_VARIANTS.forEach((variant, index) => {
    const expectedName = previewAssetFilename(variant);
    const name = changeName?.(expectedName, index) || expectedName;
    const content = new Uint8Array(513 + index).fill(index);
    contents.set(expectedName, content);
    contentSize += content.byteLength;
    parts.push(tarHeader(name, content.byteLength), content);
    parts.push(new Uint8Array((512 - (content.byteLength % 512)) % 512));
  });
  parts.push(new Uint8Array(1024));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, contents, contentSize };
}

function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const length = Math.min(bytes.byteLength - offset, 137 + (offset % 509));
      controller.enqueue(bytes.slice(offset, offset + length));
      offset += length;
    },
  });
}

describe("preview TAR extraction", () => {
  it("extracts one firmware and validates all 20 members", async () => {
    const archive = tarArchive();
    const name = "firmware-always-uv-pqc.uf2";
    const expected = archive.contents.get(name)!;
    const progress: number[] = [];

    const result = await extractPreviewTarMember(
      chunked(archive.bytes),
      name,
      expected.byteLength,
      archive.contentSize,
      (value) => progress.push(value),
    );

    expect(result).toEqual(expected);
    expect(progress.at(-1)).toBe(1);
  });

  it("rejects an invalid header checksum", async () => {
    const archive = tarArchive();
    archive.bytes[20] ^= 1;
    await expect(extractPreviewTarMember(
      chunked(archive.bytes),
      "firmware-default.uf2",
      513,
      archive.contentSize,
    )).rejects.toThrow("checksum");
  });

  it("rejects unsafe and duplicate member names", async () => {
    const unsafe = tarArchive((name, index) => index === 3 ? "../firmware.uf2" : name);
    await expect(extractPreviewTarMember(
      chunked(unsafe.bytes),
      "firmware-default.uf2",
      513,
      unsafe.contentSize,
    )).rejects.toThrow("unsafe file name");

    const duplicate = tarArchive((name, index) => index === 19 ? "firmware-default.uf2" : name);
    await expect(extractPreviewTarMember(
      chunked(duplicate.bytes),
      "firmware-default.uf2",
      513,
      duplicate.contentSize,
    )).rejects.toThrow("duplicate member");
  });

  it("rejects incomplete content metadata", async () => {
    const archive = tarArchive();
    await expect(extractPreviewTarMember(
      chunked(archive.bytes),
      "firmware-default.uf2",
      513,
      archive.contentSize - 1,
    )).rejects.toThrow("larger than its metadata");
  });

  it("uses the Rust/WASM fallback for a level-15 Zstandard archive", async () => {
    const moduleBytes = await readFile(new URL(
      "../lib/wasm/generated/preview_archive_bg.wasm",
      import.meta.url,
    ));
    await initializeWasm({ module_or_path: await WebAssembly.compile(moduleBytes) });
    const compressed = Uint8Array.from(Buffer.from(
      "KLUv/QRgPQoAsk0oGoClddFAmyiM3q6GsH16GdG6QmlKmasUxXcH3MYg1qMhKTjcg99IPEnQiMOthKs9+ImTIrOt6ZFG7Cl4gXzT7YVFdIINvYuGVeRgRQfRKrPDJXs+eEbwRA1SH/M5/INBTs7bQA6MsU9r2Og5Rm9Cp9xTnsNzp3gXpTZLAElCzC94Ujhzm6JansOPRQHKnqS7WphbVbUYIgYoozfZ88R4jQg8qMGVglIgEmoKLQdAAxHlbjEROAQJAUIYIfz/HUgsUkjgc/2HMbZa7gQg2x1AwvWcAJDtk1B2NQFhAGfpDqC5foAqbDWax/+Zba18hutr//ufkq23C7jtvAkcB+SwfWPQJ5DzHaCdwipAlBsh6gHicrflQy4QMSjA0dvP2VtgYjsA9BPAdZ9nbgN6thEomgDVBujm0T1AtexY6Sw4zHZ6zlcB1m1PJA==",
      "base64",
    ));

    const result = await extractPreviewArchive(compressed, {
      format: "tar.zst",
      filename: "preview-123-2.tar.zst",
      size: compressed.byteLength,
      uncompressedSize: 10_240,
      sha256: "0".repeat(64),
      archivedAt: "2026-09-01T00:00:00.000Z",
      downloadUrl: "/api/preview-archives/123%3A2",
    }, "firmware-default.uf2", 512, undefined, true);

    expect(result).toEqual(new Uint8Array(512));
  });
});
