import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vinext/server/app-router-entry", () => ({
  default: { fetch: vi.fn(async () => new Response("app")) },
}));

vi.mock("../lib/release-attestation", () => ({
  fetchReleaseAttestations: vi.fn(async (releases: unknown[]) => releases.map(() => ({
      repositoryId: 1266469959,
      refDigest: `sha1:${"a".repeat(40)}`,
      bundle: {},
    }))),
}));

vi.mock("../lib/release-attestation-server", () => ({
  verifyReleaseAttestationServer: vi.fn(),
}));

import worker, { releaseStorageKey, syncMirror } from "../worker/index";
import { verifyReleaseAttestationServer } from "../lib/release-attestation-server";

class MemoryKv {
  values = new Map<string, string>();

  async get(key: string, type?: string) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemoryEdgeCache {
  values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    const body = await response.arrayBuffer();
    this.values.set(request.url, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }));
  }
}

function context() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
  };
}

const asset = {
  id: 42,
  name: "rs-key-v1.0.0-default.uf2",
  size: 8,
  sha256: "",
};

function cachedRelease() {
  return {
    id: 100,
    tag: "v1.0.0",
    name: "v1",
    publishedAt: "",
    prerelease: false,
    immutable: true,
    assets: [asset],
    attestation: { repositoryId: 1266469959, refDigest: `sha1:${"a".repeat(40)}`, bundle: {} },
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(verifyReleaseAttestationServer).mockResolvedValue(undefined);
  asset.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("firmware"))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
});

describe("Worker cache", () => {
  it("serves release metadata from the Cloudflare edge cache", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v2", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [cachedRelease()],
    }));
    const edge = new MemoryEdgeCache();
    vi.stubGlobal("caches", { default: edge });

    const firstContext = context();
    const first = await worker.fetch(
      new Request("https://flasher.test/api/releases?ignored=1"),
      { GITHUB_CACHE: kv } as never,
      firstContext,
    );
    await first.text();
    await Promise.all(firstContext.pending);

    const second = await worker.fetch(
      new Request("https://flasher.test/api/releases"),
      { GITHUB_CACHE: kv } as never,
      context(),
    );

    expect(second.headers.get("X-RS-Key-Cache")).toBe("EDGE-HIT");
    expect(second.headers.get("Cloudflare-CDN-Cache-Control")).toContain("max-age=300");
    expect(second.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(second.headers.get("Cache-Tag")).toBe("rs-key-releases");
    expect(edge.values).toHaveLength(1);
  });

  it("redirects a stored asset without validating its manifest or metadata", async () => {
    const kv = new MemoryKv();
    const kvGet = vi.spyOn(kv, "get");
    const edge = new MemoryEdgeCache();
    vi.stubGlobal("caches", { default: edge });
    const storage = {
      head: vi.fn(async () => ({
        size: asset.size + 1,
        customMetadata: { sha256: "0".repeat(64) },
        httpEtag: "test-etag",
      })),
    };
    const query = new URLSearchParams({
      size: String(asset.size),
      sha256: asset.sha256,
      name: asset.name,
      tag: "v1.0.0",
    });

    const firstContext = context();
    const first = await worker.fetch(
      new Request(`https://flasher.test/api/assets/${asset.id}?${query}`),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: storage, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
      firstContext,
    );
    expect(first.status).toBe(307);
    expect(first.headers.get("Location")).toBe(`https://assets.test/releases/v1.0.0/${asset.name}`);
    expect(first.headers.get("X-RS-Key-Cache")).toBe("STORAGE-HIT");
    expect(kvGet).not.toHaveBeenCalled();
    expect(await first.text()).toBe("");
    await Promise.all(firstContext.pending);

    const second = await worker.fetch(
      new Request(`https://flasher.test/api/assets/${asset.id}?${query}`),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: storage, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
      context(),
    );
    expect(second.status).toBe(307);
    expect(second.headers.get("X-RS-Key-Cache")).toBe("EDGE-HIT");
    expect(storage.head).toHaveBeenCalledTimes(1);
  });

  it("keeps the original filename in the storage key and response", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v2", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [cachedRelease()],
    }));

    const writes: Array<{ key: string; bytes: Uint8Array; options: unknown }> = [];
    const storage = {
      head: vi.fn(async () => null),
      put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>, options: unknown) => {
        writes.push({ key, bytes: new Uint8Array(await new Response(body).arrayBuffer()), options });
        return {};
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("firmware", {
      headers: { "Content-Length": String(asset.size) },
    })));

    const ctx = context();
    const query = new URLSearchParams({
      tag: "v1.0.0",
      name: asset.name,
      size: String(asset.size),
      sha256: asset.sha256,
    });
    const response = await worker.fetch(
      new Request(`https://flasher.test/api/assets/${asset.id}?${query}`),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: storage, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
      ctx,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(`https://assets.test/releases/v1.0.0/${asset.name}`);
    expect(writes[0].key).toBe(`releases/v1.0.0/${asset.name}`);
    expect(response.headers.get("X-RS-Key-Cache")).toBe("STORAGE-MISS");
  });

  it("serves stale KV metadata when GitHub is down", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v2", JSON.stringify({
      refreshedAt: 1,
      releases: [cachedRelease()],
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));

    const response = await worker.fetch(
      new Request("https://flasher.test/api/releases"),
      { GITHUB_CACHE: kv } as never,
      context(),
    );
    const manifest = await response.json() as { stale: boolean; releases: unknown[] };

    expect(response.status).toBe(200);
    expect(manifest.stale).toBe(true);
    expect(manifest.releases).toHaveLength(1);
  });

  it("does not publish assets when the server-side attestation check fails", async () => {
    const kv = new MemoryKv();
    vi.mocked(verifyReleaseAttestationServer).mockRejectedValueOnce(new Error("invalid keyless signature"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{
      id: 100,
      tag_name: "v1.0.0",
      name: "v1",
      published_at: "",
      prerelease: false,
      draft: false,
      immutable: true,
      assets: [{ ...asset, digest: `sha256:${asset.sha256}` }],
    }])));

    const response = await worker.fetch(
      new Request("https://flasher.test/api/releases"),
      { GITHUB_CACHE: kv } as never,
      context(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("invalid keyless signature") });
    expect(kv.values.has("releases:v2")).toBe(false);
  });

  it("uses the release tag and exact filename for storage paths", () => {
    expect(releaseStorageKey("v0.4.10", "rs-key-v0.4.10-display.uf2"))
      .toBe("releases/v0.4.10/rs-key-v0.4.10-display.uf2");
  });

  it("lists release storage metadata and keeps unmatched objects", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v2", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [cachedRelease()],
    }));
    const object = (key: string) => ({
      key,
      version: "version-1",
      size: asset.size,
      etag: "etag-1",
      uploaded: new Date("2026-08-29T12:00:00.000Z"),
      storageClass: "Standard",
      checksums: {},
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: asset.sha256 },
    });
    const matchedKey = `releases/v1.0.0/${asset.name}`;
    const bucket = {
      list: vi.fn(async () => ({
        objects: [object(matchedKey), object("releases/orphan/file.uf2")],
        truncated: true,
        cursor: "next-page",
      })),
    };
    const edge = new MemoryEdgeCache();
    vi.stubGlobal("caches", { default: edge });
    const firstContext = context();

    const response = await worker.fetch(
      new Request("https://flasher.test/api/storage/releases?limit=2"),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: bucket, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
      firstContext,
    );
    const body = await response.json() as {
      items: Array<{ object: { key: string }; releaseAsset: unknown }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(bucket.list).toHaveBeenCalledWith(expect.objectContaining({
      prefix: "releases/",
      limit: 2,
      include: ["httpMetadata", "customMetadata"],
    }));
    expect(body.items[0]).toMatchObject({ object: { key: matchedKey }, releaseAsset: { tag: "v1.0.0" } });
    expect(body.items[1].releaseAsset).toBeNull();
    expect(body.nextCursor).toBe("next-page");
    await Promise.all(firstContext.pending);

    const cached = await worker.fetch(
      new Request("https://flasher.test/api/storage/releases?limit=2"),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: bucket, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
      context(),
    );
    expect(cached.headers.get("X-RS-Key-Cache")).toBe("EDGE-HIT");
    expect(bucket.list).toHaveBeenCalledTimes(1);
  });

  it("continues a mirror after the last completed asset", async () => {
    const kv = new MemoryKv();
    const firstBytes = new TextEncoder().encode("first");
    const secondBytes = new TextEncoder().encode("second");
    const digest = async (bytes: Uint8Array) => Array.from(
      new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const first = { id: 1, name: "first.uf2", size: firstBytes.length, digest: `sha256:${await digest(firstBytes)}` };
    const second = { id: 2, name: "second.uf2", size: secondBytes.length, digest: `sha256:${await digest(secondBytes)}` };
    let secondAttempts = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify([{
          id: 100,
          tag_name: "v1.0.0",
          name: "v1",
          published_at: "",
          prerelease: false,
          draft: false,
          immutable: true,
          assets: [first, second],
        }]), { headers: { ETag: "test" } });
      }
      if (url.endsWith("/first.uf2")) return new Response(firstBytes, { headers: { "Content-Length": String(firstBytes.length) } });
      secondAttempts++;
      if (secondAttempts === 1) return new Response("down", { status: 503 });
      return new Response(secondBytes, { headers: { "Content-Length": String(secondBytes.length) } });
    }));

    const objects = new Map<string, Uint8Array>();
    const storage = {
      head: vi.fn(async (key: string) => objects.has(key) ? { size: objects.get(key)!.length, customMetadata: {} } : null),
      put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
        objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
        return {};
      }),
    };
    const env = { GITHUB_CACHE: kv, RELEASE_ASSETS: storage } as never;

    await syncMirror(env);
    expect(JSON.parse(kv.values.get("mirror:v1") || "{}").cursorAssetId).toBe(1);
    await syncMirror(env);
    expect(JSON.parse(kv.values.get("mirror:v1") || "{}").completedAt).toBeTruthy();
    expect(objects.size).toBe(2);
  });
});
