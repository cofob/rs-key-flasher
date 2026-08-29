import handler from "vinext/server/app-router-entry";
import { fetchReleaseAttestations } from "../lib/release-attestation";
import { verifyReleaseAttestationServer } from "../lib/release-attestation-server";
import { parseAntiRollbackEpochMarker, type Release, type ReleaseAsset, type ReleaseManifest } from "../lib/releases";
import { cleanupPreviews, handlePreviewRequest, type PreviewEnv } from "./previews";
import { assetRedirect, listStorageObjects, parseStorageListQuery, publicAssetUrl } from "./storage";

const REPOSITORY = "TheMaxMur/RS-Key";
const RELEASES_KEY = "releases:v2";
const MIRROR_KEY = "mirror:v1";
const HOUR = 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const MAX_ASSET_SIZE = 32 * 1024 * 1024;
const MAX_MIRROR_ASSETS = 400;
const MAX_MIRROR_TIME = 12 * 60 * 1000;

interface Env extends PreviewEnv {
  ASSETS: Fetcher;
  GITHUB_CACHE?: KVNamespace;
  RELEASE_ASSETS?: R2Bucket;
  ASSET_PUBLIC_BASE_URL?: string;
  GITHUB_TOKEN?: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type EdgeCacheStorage = CacheStorage & { default?: Cache };

interface CachedReleases {
  etag?: string;
  refreshedAt: number;
  retryAfter?: number;
  releases: Release[];
}

interface MirrorState {
  cursorAssetId?: number;
  completedAt?: string;
  lastError?: string;
}

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  immutable: boolean;
  body: string | null;
  assets: GitHubAsset[];
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function defaultEdgeCache(): Cache | undefined {
  return (globalThis as typeof globalThis & { caches?: EdgeCacheStorage }).caches?.default;
}

function edgeHit(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-RS-Key-Cache", "EDGE-HIT");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cacheResponse(ctx: WorkerContext, key: Request, response: Response): void {
  const cache = defaultEdgeCache();
  if (!cache || (!response.ok && response.status !== 307)) return;
  ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
}

function apiCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

async function cachedApiResponse(
  request: Request,
  ctx: WorkerContext,
  load: () => Promise<Response>,
): Promise<Response> {
  const key = apiCacheKey(request);
  const cached = await defaultEdgeCache()?.match(key);
  if (cached) return edgeHit(cached);
  const response = await load();
  if ((response.ok || response.status === 307) && !response.headers.has("X-RS-Key-Cache")) {
    response.headers.set("X-RS-Key-Cache", "MISS");
  }
  cacheResponse(ctx, key, response);
  return response;
}

function releasesCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function githubHeaders(env: Env, etag?: string): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "rs-key-web-flasher",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (env.GITHUB_TOKEN) headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
  if (etag) headers.set("If-None-Match", etag);
  return headers;
}

function sanitizeReleases(raw: GitHubRelease[]): Release[] {
  return raw.filter((release) => !release.draft && Number.isSafeInteger(release.id)).map((release) => {
    const antiRollbackEpoch = parseAntiRollbackEpochMarker(release.body);
    return {
      id: release.id,
      tag: release.tag_name,
      name: release.name || release.tag_name,
      publishedAt: release.published_at || "",
      prerelease: release.prerelease,
      immutable: release.immutable === true,
      ...(antiRollbackEpoch ? { antiRollbackEpoch } : {}),
      assets: release.assets.flatMap((asset): ReleaseAsset[] => {
        const sha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
        if (!sha256) return [];
        return [{ id: asset.id, name: asset.name, size: asset.size, sha256 }];
      }),
    };
  });
}

async function readCachedReleases(env: Env): Promise<CachedReleases | null> {
  return env.GITHUB_CACHE?.get<CachedReleases>(RELEASES_KEY, "json") ?? null;
}

async function writeCachedReleases(env: Env, value: CachedReleases): Promise<void> {
  await env.GITHUB_CACHE?.put(RELEASES_KEY, JSON.stringify(value));
}

async function getReleases(env: Env, force = false): Promise<{ value: CachedReleases; stale: boolean; source: string }> {
  const now = Date.now();
  const cached = await readCachedReleases(env);
  if (!force && cached && now - cached.refreshedAt < HOUR) return { value: cached, stale: false, source: "KV" };
  if (!force && cached?.retryAfter && cached.retryAfter > now) return { value: cached, stale: true, source: "KV-STALE" };

  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`, {
      headers: githubHeaders(env, cached?.etag),
    });

    if (response.status === 304 && cached) {
      const value = { ...cached, refreshedAt: now, retryAfter: undefined };
      await writeCachedReleases(env, value);
      return { value, stale: false, source: "GITHUB-304" };
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const candidates = sanitizeReleases(await response.json() as GitHubRelease[]);
    if (!candidates.length) throw new Error("GitHub returned no release.");
    const attestations = await fetchReleaseAttestations(candidates, githubHeaders(env));
    const releases = await Promise.all(candidates.map(async (release, index): Promise<Release> => {
      const attestation = attestations[index];
      await verifyReleaseAttestationServer(release, attestation);
      return { ...release, attestation };
    }));
    const value: CachedReleases = {
      etag: response.headers.get("ETag") || undefined,
      refreshedAt: now,
      releases,
    };
    await writeCachedReleases(env, value);
    return { value, stale: false, source: env.GITHUB_CACHE ? "GITHUB" : "DIRECT" };
  } catch (error) {
    if (!cached) throw error;
    const value = { ...cached, retryAfter: now + RETRY_DELAY };
    await writeCachedReleases(env, value);
    return { value, stale: true, source: "KV-STALE" };
  }
}

function publicManifest(result: Awaited<ReturnType<typeof getReleases>>): ReleaseManifest {
  return {
    refreshedAt: new Date(result.value.refreshedAt).toISOString(),
    stale: result.stale,
    releases: result.value.releases,
  };
}

function safeTag(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value);
}

function safeName(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,199}$/.test(value);
}

function contentDisposition(name: string): string {
  return `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function releaseStorageKey(tag: string, name: string): string {
  return `releases/${tag}/${name}`;
}

function sourceUrl(tag: string, name: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function hashBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

async function fetchAsset(tag: string, name: string, size: number): Promise<Response> {
  const response = await fetch(sourceUrl(tag, name), { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GitHub asset download returned ${response.status}`);
  const contentLength = response.headers.get("Content-Length");
  if (!contentLength || Number(contentLength) !== size) throw new Error("GitHub asset size does not match release metadata.");
  return response;
}

function findAsset(releases: Release[], id: number, tag: string, name: string, size: number, sha256: string): boolean {
  const release = releases.find((candidate) => candidate.tag === tag);
  const asset = release?.assets.find((candidate) => candidate.id === id);
  return Boolean(release?.attestation && asset && asset.name === name && asset.size === size && asset.sha256 === sha256);
}

async function serveAsset(request: Request, env: Env, assetId: number): Promise<Response> {
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag") || "";
  const name = url.searchParams.get("name") || "";
  const sha256 = (url.searchParams.get("sha256") || "").toLowerCase();
  const size = Number(url.searchParams.get("size"));

  if (!Number.isSafeInteger(assetId) || assetId <= 0 || !safeTag(tag) || !safeName(name) ||
      !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_SIZE) {
    return json({ error: "Invalid asset request." }, { status: 400 });
  }

  if (!env.RELEASE_ASSETS || !publicAssetUrl(env.ASSET_PUBLIC_BASE_URL, releaseStorageKey(tag, name))) {
    return json({ error: "Public asset storage is not configured." }, { status: 503 });
  }

  const key = releaseStorageKey(tag, name);
  const cached = await env.RELEASE_ASSETS.head(key);
  if (cached) {
    const response = assetRedirect(env.ASSET_PUBLIC_BASE_URL, key, "public, max-age=31536000, immutable")!;
    response.headers.set("X-RS-Key-Cache", "STORAGE-HIT");
    return response;
  }

  try {
    let manifest = await readCachedReleases(env);
    if (!manifest) manifest = (await getReleases(env)).value;
    if (!findAsset(manifest.releases, assetId, tag, name, size, sha256)) {
      return json({ error: "Asset is not present in the cached RS-Key release manifest." }, { status: 404 });
    }

    const origin = await fetchAsset(tag, name, size);
    if (!origin.body) throw new Error("GitHub asset stream is missing.");
    await env.RELEASE_ASSETS.put(key, origin.body, {
      sha256: hashBytes(sha256),
      httpMetadata: {
        contentType: "application/octet-stream",
        contentDisposition: contentDisposition(name),
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { assetId: String(assetId), filename: name, sha256, tag },
    });
    const response = assetRedirect(env.ASSET_PUBLIC_BASE_URL, key, "public, max-age=31536000, immutable")!;
    response.headers.set("X-RS-Key-Cache", "STORAGE-MISS");
    return response;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Asset download failed." }, { status: 502 });
  }
}

async function listReleaseStorage(request: Request, env: Env): Promise<Response> {
  if (!env.RELEASE_ASSETS || !publicAssetUrl(env.ASSET_PUBLIC_BASE_URL, "releases/test")) {
    return json({ error: "Public asset storage is not configured." }, { status: 503 });
  }
  const url = new URL(request.url);
  const query = parseStorageListQuery(url);
  const tag = (url.searchParams.get("tag") || "").trim();
  if (!query || (tag && !safeTag(tag))) return json({ error: "Invalid storage inventory query." }, { status: 400 });

  try {
    const listed = await listStorageObjects(
      env.RELEASE_ASSETS,
      env.ASSET_PUBLIC_BASE_URL!,
      tag ? `releases/${tag}/` : "releases/",
      query,
    );
    const manifest = await readCachedReleases(env);
    const releases = manifest?.releases || [];
    const items = listed.objects.map((object) => {
      const match = releases.flatMap((release) => release.assets.map((asset) => ({ release, asset })))
        .find(({ release, asset }) => releaseStorageKey(release.tag, asset.name) === object.key);
      return {
        object,
        releaseAsset: match ? {
          releaseId: match.release.id,
          tag: match.release.tag,
          releaseName: match.release.name,
          publishedAt: match.release.publishedAt,
          prerelease: match.release.prerelease,
          immutable: match.release.immutable,
          asset: match.asset,
        } : null,
      };
    });
    return json({ items, nextCursor: listed.nextCursor }, {
      headers: { "Cache-Control": "public, max-age=15, s-maxage=30" },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Storage inventory is unavailable." }, { status: 502 });
  }
}

async function mirrorAsset(env: Env, tag: string, asset: ReleaseAsset): Promise<void> {
  if (!env.RELEASE_ASSETS) return;
  const key = releaseStorageKey(tag, asset.name);
  const current = await env.RELEASE_ASSETS.head(key);
  if (current && current.size === asset.size && current.customMetadata?.sha256 === asset.sha256) return;

  const response = await fetchAsset(tag, asset.name, asset.size);
  await env.RELEASE_ASSETS.put(key, response.body, {
    sha256: hashBytes(asset.sha256),
    httpMetadata: {
      contentType: "application/octet-stream",
      contentDisposition: contentDisposition(asset.name),
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { assetId: String(asset.id), filename: asset.name, sha256: asset.sha256, tag },
  });
}

async function syncMirror(env: Env): Promise<void> {
  if (!env.GITHUB_CACHE || !env.RELEASE_ASSETS) return;
  const started = Date.now();
  const manifest = await getReleases(env, true);
  const queue = manifest.value.releases.flatMap((release) =>
    release.assets.map((asset) => ({ tag: release.tag, asset })),
  ).sort((a, b) => a.asset.id - b.asset.id);

  const state = await env.GITHUB_CACHE.get<MirrorState>(MIRROR_KEY, "json") || {};
  const cursorIndex = state.cursorAssetId ? queue.findIndex((item) => item.asset.id === state.cursorAssetId) : -1;
  let index = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  let processed = 0;
  let cursorAssetId = state.cursorAssetId;

  for (; index < queue.length && processed < MAX_MIRROR_ASSETS && Date.now() - started < MAX_MIRROR_TIME; index++) {
    const item = queue[index];
    try {
      await mirrorAsset(env, item.tag, item.asset);
      processed++;
      cursorAssetId = item.asset.id;
      await env.GITHUB_CACHE.put(MIRROR_KEY, JSON.stringify({ cursorAssetId } satisfies MirrorState));
    } catch (error) {
      const lastError = error instanceof Error ? error.message : "Mirror failed";
      await env.GITHUB_CACHE.put(MIRROR_KEY, JSON.stringify({ cursorAssetId, lastError } satisfies MirrorState));
      return;
    }
  }

  if (index >= queue.length) {
    await env.GITHUB_CACHE.put(MIRROR_KEY, JSON.stringify({ completedAt: new Date().toISOString() } satisfies MirrorState));
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/releases") {
      const edgeKey = releasesCacheKey(request);
      const edgeCached = await defaultEdgeCache()?.match(edgeKey);
      if (edgeCached) return edgeHit(edgeCached);
      try {
        const result = await getReleases(env);
        const response = json(publicManifest(result), {
          headers: {
            "Cache-Tag": "rs-key-releases",
            "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=300",
            "Cloudflare-CDN-Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
            "X-RS-Key-Cache": result.source,
          },
        });
        cacheResponse(ctx, edgeKey, response);
        return response;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "GitHub releases are unavailable." }, { status: 502 });
      }
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/(\d+)$/);
    if (request.method === "GET" && assetMatch) {
      return cachedApiResponse(request, ctx, () => serveAsset(request, env, Number(assetMatch[1])));
    }

    if (request.method === "GET" && url.pathname === "/api/storage/releases") {
      return cachedApiResponse(request, ctx, () => listReleaseStorage(request, env));
    }

    const cacheablePreviewPath = request.method === "GET" && (
      url.pathname === "/api/previews" ||
      /^\/api\/previews\/[^/]+$/.test(url.pathname) ||
      /^\/api\/preview-assets\/\d+$/.test(url.pathname) ||
      url.pathname === "/api/storage/previews"
    );
    if (cacheablePreviewPath) {
      return cachedApiResponse(request, ctx, async () =>
        await handlePreviewRequest(request, env) || json({ error: "Not found." }, { status: 404 }));
    }

    const previewResponse = await handlePreviewRequest(request, env);
    if (previewResponse) return previewResponse;

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, { status: 404 });
    return handler.fetch(request, env, ctx);
  },

  async scheduled(_controller: unknown, env: Env, ctx: WorkerContext): Promise<void> {
    ctx.waitUntil(syncMirror(env));
    ctx.waitUntil(cleanupPreviews(env));
  },
};

export { getReleases, releaseStorageKey, syncMirror };
export default worker;
