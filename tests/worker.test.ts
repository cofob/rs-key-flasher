import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vinext/server/app-router-entry", () => ({
  default: { fetch: vi.fn(async () => new Response("app")) },
}));

import worker, { r2Key, syncMirror } from "../worker/index";

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

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  asset.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("firmware"))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
});

describe("Worker cache", () => {
  it("serves release metadata from the Cloudflare edge cache", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v1", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [{ tag: "v1.0.0", name: "v1", publishedAt: "", prerelease: false, assets: [asset] }],
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

  it("serves a verified R2 asset from the Cloudflare edge cache", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v1", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [{ tag: "v1.0.0", name: "v1", publishedAt: "", prerelease: false, assets: [asset] }],
    }));
    const edge = new MemoryEdgeCache();
    vi.stubGlobal("caches", { default: edge });
    const r2 = {
      get: vi.fn(async () => ({
        size: asset.size,
        customMetadata: { sha256: asset.sha256 },
        httpEtag: "test-etag",
        body: new Response("firmware").body,
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
      { GITHUB_CACHE: kv, RELEASE_ASSETS: r2 } as never,
      firstContext,
    );
    expect(await first.text()).toBe("firmware");
    await Promise.all(firstContext.pending);

    const second = await worker.fetch(
      new Request(`https://flasher.test/api/assets/${asset.id}?${query}`),
      { GITHUB_CACHE: kv, RELEASE_ASSETS: r2 } as never,
      context(),
    );

    expect(await second.text()).toBe("firmware");
    expect(second.headers.get("X-RS-Key-Cache")).toBe("EDGE-HIT");
    expect(second.headers.get("Cache-Tag")).toBe("rs-key-release-assets");
    expect(r2.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the original filename in the R2 key and response", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v1", JSON.stringify({
      refreshedAt: Date.now(),
      releases: [{ tag: "v1.0.0", name: "v1", publishedAt: "", prerelease: false, assets: [asset] }],
    }));

    const writes: Array<{ key: string; bytes: Uint8Array; options: unknown }> = [];
    const r2 = {
      get: vi.fn(async () => null),
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
      { GITHUB_CACHE: kv, RELEASE_ASSETS: r2 } as never,
      ctx,
    );
    const clientBytes = new Uint8Array(await response.arrayBuffer());
    await Promise.all(ctx.pending);

    expect(new TextDecoder().decode(clientBytes)).toBe("firmware");
    expect(writes[0].key).toBe(`releases/v1.0.0/${asset.name}`);
    expect(response.headers.get("Content-Disposition")).toContain(asset.name);
    expect(response.headers.get("X-RS-Key-Cache")).toBe("R2-MISS");
  });

  it("serves stale KV metadata when GitHub is down", async () => {
    const kv = new MemoryKv();
    kv.values.set("releases:v1", JSON.stringify({
      refreshedAt: 1,
      releases: [{ tag: "v1.0.0", name: "v1", publishedAt: "", prerelease: false, assets: [asset] }],
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

  it("uses the release tag and exact filename for R2 paths", () => {
    expect(r2Key("v0.4.10", "rs-key-v0.4.10-display.uf2"))
      .toBe("releases/v0.4.10/rs-key-v0.4.10-display.uf2");
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
          tag_name: "v1.0.0",
          name: "v1",
          published_at: "",
          prerelease: false,
          draft: false,
          assets: [first, second],
        }]), { headers: { ETag: "test" } });
      }
      if (url.endsWith("/first.uf2")) return new Response(firstBytes, { headers: { "Content-Length": String(firstBytes.length) } });
      secondAttempts++;
      if (secondAttempts === 1) return new Response("down", { status: 503 });
      return new Response(secondBytes, { headers: { "Content-Length": String(secondBytes.length) } });
    }));

    const objects = new Map<string, Uint8Array>();
    const r2 = {
      head: vi.fn(async (key: string) => objects.has(key) ? { size: objects.get(key)!.length, customMetadata: {} } : null),
      put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
        objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
        return {};
      }),
    };
    const env = { GITHUB_CACHE: kv, RELEASE_ASSETS: r2 } as never;

    await syncMirror(env);
    expect(JSON.parse(kv.values.get("mirror:v1") || "{}").cursorAssetId).toBe(1);
    await syncMirror(env);
    expect(JSON.parse(kv.values.get("mirror:v1") || "{}").completedAt).toBeTruthy();
    expect(objects.size).toBe(2);
  });
});
