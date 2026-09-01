import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUrl, downloadAsset } from "../lib/assets";
import type { FirmwareAsset } from "../lib/releases";

const asset: FirmwareAsset = {
  source: "release",
  id: 42,
  name: "rs-key-v1.0.0-fips-pqc.uf2",
  size: 8192,
  sha256: "b".repeat(64),
  tag: "v1.0.0",
  version: "1.0.0",
  variant: "fips-pqc",
};

describe("firmware asset URL", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses the cache proxy by default", () => {
    const url = assetUrl(asset);
    expect(url).toContain("/api/assets/42?");
    expect(url).toContain("sha256=");
  });

  it("uses the GitHub asset URL in direct mode", () => {
    expect(assetUrl({ ...asset, downloadUrl: "https://example.test/firmware.uf2" }, true))
      .toBe("https://example.test/firmware.uf2");
    expect(assetUrl(asset, true))
      .toBe("https://github.com/TheMaxMur/RS-Key/releases/download/v1.0.0/rs-key-v1.0.0-fips-pqc.uf2");
  });

  it("rejects an archive before decompression when its SHA-256 is wrong", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));

    await expect(downloadAsset({
      source: "preview",
      id: 77,
      buildId: "123:2",
      commitSha: "a".repeat(40),
      name: "firmware-default.uf2",
      size: 512,
      sha256: "b".repeat(64),
      variant: "default",
      version: "aaaaaaaaaaaa",
      archive: {
        format: "tar.zst",
        filename: "preview-123-2.tar.zst",
        size: bytes.byteLength,
        uncompressedSize: 10_240,
        sha256: "c".repeat(64),
        archivedAt: "2026-09-01T00:00:00.000Z",
        downloadUrl: "/api/preview-archives/123%3A2",
      },
    })).rejects.toThrow("archive SHA-256");
  });
});
