import { describe, expect, it, vi } from "vitest";
import { listStorageObjects, parseStorageListQuery, publicAssetUrl } from "../worker/storage";

describe("public storage API helpers", () => {
  it("joins and encodes object keys below the configured origin", () => {
    expect(publicAssetUrl("https://assets.test/", "releases/v1.0/file name+#.uf2"))
      .toBe("https://assets.test/releases/v1.0/file%20name%2B%23.uf2");
  });

  it("rejects missing and non-origin public base URLs", () => {
    expect(publicAssetUrl(undefined, "releases/file.uf2")).toBeNull();
    expect(publicAssetUrl("ftp://assets.test", "releases/file.uf2")).toBeNull();
    expect(publicAssetUrl("https://assets.test/prefix", "releases/file.uf2")).toBeNull();
  });

  it("validates inventory pagination", () => {
    expect(parseStorageListQuery(new URL("https://test/api/storage/releases"))).toEqual({ limit: 50 });
    expect(parseStorageListQuery(new URL("https://test/api/storage/releases?limit=100&cursor=next")))
      .toEqual({ limit: 100, cursor: "next" });
    expect(parseStorageListQuery(new URL("https://test/api/storage/releases?limit=101"))).toBeNull();
  });

  it("requests and serializes complete object metadata", async () => {
    const checksum = Uint8Array.from([0xab, 0xcd]).buffer;
    const list = vi.fn(async () => ({
      objects: [{
        key: "releases/v1/file.uf2",
        version: "version-1",
        size: 512,
        etag: "etag-1",
        uploaded: new Date("2026-08-29T12:00:00.000Z"),
        storageClass: "Standard",
        checksums: { sha256: checksum },
        httpMetadata: { contentType: "application/octet-stream", cacheExpiry: new Date("2026-09-01T00:00:00.000Z") },
        customMetadata: { sha256: "abcd" },
      }],
      truncated: true,
      cursor: "next-page",
    }));

    const result = await listStorageObjects(
      { list } as never,
      "https://assets.test",
      "releases/",
      { limit: 25 },
    );

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      prefix: "releases/",
      limit: 25,
      include: ["httpMetadata", "customMetadata"],
    }));
    expect(result).toEqual({
      objects: [{
        key: "releases/v1/file.uf2",
        version: "version-1",
        size: 512,
        etag: "etag-1",
        uploadedAt: "2026-08-29T12:00:00.000Z",
        storageClass: "Standard",
        checksums: { sha256: "abcd" },
        httpMetadata: { contentType: "application/octet-stream", cacheExpiry: "2026-09-01T00:00:00.000Z" },
        customMetadata: { sha256: "abcd" },
        publicUrl: "https://assets.test/releases/v1/file.uf2",
      }],
      nextCursor: "next-page",
    });
  });
});
