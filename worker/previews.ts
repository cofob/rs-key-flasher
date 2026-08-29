import { parseUf2 } from "../lib/uf2";
import {
  PREVIEW_VARIANTS,
  previewAssetFilename,
  type PreviewAsset,
  type PreviewBuild,
  type PreviewBuildSummary,
  type PreviewKind,
  type PreviewPullRequest,
  type PreviewUploadMetadata,
} from "../lib/previews";
import {
  githubOidcTrustFromEnv,
  type GitHubOidcEnv,
  verifyGitHubOidcToken,
} from "./github-oidc";
import { assetRedirect, listStorageObjects, parseStorageListQuery, publicAssetUrl } from "./storage";

const RP2350_ARM_SECURE = 0xe48bff59;
const MAX_ASSET_SIZE = 32 * 1024 * 1024;
const MAX_UPLOAD_SIZE = 96 * 1024 * 1024;
const RETENTION_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface PreviewEnv extends GitHubOidcEnv {
  PREVIEWS?: D1Database;
  RELEASE_ASSETS?: R2Bucket;
  ASSET_PUBLIC_BASE_URL?: string;
}

interface BuildRow {
  id: string;
  run_id: number;
  run_attempt: number;
  event: "pull_request" | "push";
  status: "uploading" | "ready" | "failed";
  commit_sha: string;
  branch: string;
  actor: string;
  run_url: string;
  repository: string;
  source_repository: string;
  metadata_json: string;
  created_at: number;
  published_at: number | null;
  expires_at: number;
  asset_count?: number;
}

interface PullRequestRow {
  build_id: string;
  pr_number: number;
  title: string;
  url: string;
  base_branch: string;
}

interface AssetRow {
  id: number;
  build_id: string;
  variant: string;
  filename: string;
  size: number;
  sha256: string;
  r2_key: string;
}

interface PreviewInventoryRow extends BuildRow {
  asset_id: number;
  asset_build_id: string;
  asset_variant: string;
  asset_filename: string;
  asset_size: number;
  asset_sha256: string;
  asset_storage_key: string;
}

interface Cursor {
  publishedAt: number;
  id: string;
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function invalid(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value);
}

function parsePullRequest(value: unknown): PreviewPullRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || Number(value.number) <= 0 ||
      !isSafeText(value.title, 500) || !isSafeText(value.url, 500) || !isSafeText(value.baseBranch, 255)) {
    throw new Error("Invalid pull request metadata.");
  }
  const url = new URL(value.url);
  if (url.protocol !== "https:") throw new Error("Invalid pull request URL.");
  return { number: Number(value.number), title: value.title, url: url.toString(), baseBranch: value.baseBranch };
}

export function parsePreviewMetadata(value: unknown): PreviewUploadMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isSafeText(value.repository, 255) ||
      !Number.isSafeInteger(value.repositoryId) || Number(value.repositoryId) <= 0 ||
      (value.event !== "pull_request" && value.event !== "push") ||
      !Number.isSafeInteger(value.runId) || Number(value.runId) <= 0 ||
      !Number.isSafeInteger(value.runAttempt) || Number(value.runAttempt) <= 0 ||
      !isSafeText(value.runUrl, 500) || !isSafeText(value.branch, 255) || !isSafeText(value.actor, 255) ||
      !isSafeText(value.sourceRepository, 255) || !isSafeText(value.createdAt, 64) ||
      typeof value.commitSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.commitSha) ||
      !Array.isArray(value.pullRequests) || !Array.isArray(value.assets)) {
    throw new Error("Invalid preview metadata.");
  }

  const runUrl = new URL(value.runUrl);
  if (runUrl.protocol !== "https:") throw new Error("Invalid CI run URL.");
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid CI creation time.");

  const pullRequests = value.pullRequests.map(parsePullRequest);
  if (new Set(pullRequests.map((item) => item.number)).size !== pullRequests.length) {
    throw new Error("Duplicate pull request metadata.");
  }
  const expected = new Set<string>(PREVIEW_VARIANTS);
  const assets = value.assets.map((asset) => {
    if (!isRecord(asset) || typeof asset.variant !== "string" || !expected.has(asset.variant) ||
        asset.filename !== previewAssetFilename(asset.variant) || !Number.isSafeInteger(asset.size) ||
        Number(asset.size) < 512 || Number(asset.size) > MAX_ASSET_SIZE ||
        typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
      throw new Error("Invalid preview asset metadata.");
    }
    return {
      variant: asset.variant as PreviewUploadMetadata["assets"][number]["variant"],
      filename: asset.filename,
      size: Number(asset.size),
      sha256: asset.sha256.toLowerCase(),
    };
  });
  if (assets.length !== PREVIEW_VARIANTS.length || new Set(assets.map((asset) => asset.variant)).size !== PREVIEW_VARIANTS.length) {
    throw new Error("The upload must contain the complete set of 20 safe variants.");
  }
  const uploadSize = assets.reduce((sum, asset) => sum + asset.size, 0);
  if (uploadSize > MAX_UPLOAD_SIZE) throw new Error("The preview upload is too large.");

  return {
    schemaVersion: 1,
    repository: value.repository,
    repositoryId: Number(value.repositoryId),
    event: value.event,
    runId: Number(value.runId),
    runAttempt: Number(value.runAttempt),
    runUrl: runUrl.toString(),
    commitSha: value.commitSha.toLowerCase(),
    branch: value.branch,
    actor: value.actor,
    sourceRepository: value.sourceRepository,
    createdAt: createdAt.toISOString(),
    pullRequests,
    assets: assets.sort((a, b) => a.variant.localeCompare(b.variant)),
  };
}

function canonicalMetadata(metadata: PreviewUploadMetadata): string {
  return JSON.stringify({
    ...metadata,
    pullRequests: [...metadata.pullRequests].sort((a, b) => a.number - b.number),
    assets: [...metadata.assets].sort((a, b) => a.variant.localeCompare(b.variant)),
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validatePreviewAssetBytes(
  asset: PreviewUploadMetadata["assets"][number],
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== asset.size) throw new Error(`File size does not match ${asset.filename}.`);
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`SHA-256 does not match ${asset.filename}.`);
  const image = parseUf2(bytes);
  if (image.familyId !== RP2350_ARM_SECURE) throw new Error(`${asset.filename} does not target RP2350 Arm Secure.`);
}

function previewStorageKey(metadata: PreviewUploadMetadata, variant: string, sha256: string): string {
  return `previews/${metadata.runId}/${metadata.runAttempt}/${sha256}-${variant}.uf2`;
}

function toPullRequest(row: PullRequestRow): PreviewPullRequest {
  return { number: row.pr_number, title: row.title, url: row.url, baseBranch: row.base_branch };
}

function toSummary(row: BuildRow, pullRequests: PreviewPullRequest[]): PreviewBuildSummary {
  return {
    id: row.id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    event: row.event,
    commitSha: row.commit_sha,
    branch: row.branch,
    actor: row.actor,
    runUrl: row.run_url,
    repository: row.repository,
    sourceRepository: row.source_repository,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    publishedAt: new Date((row.published_at || row.created_at) * 1000).toISOString(),
    expiresAt: new Date(row.expires_at * 1000).toISOString(),
    pullRequests,
    assetCount: row.asset_count || 0,
  };
}

function toAsset(row: AssetRow): PreviewAsset {
  return {
    id: row.id,
    buildId: row.build_id,
    variant: row.variant as PreviewAsset["variant"],
    filename: row.filename,
    size: row.size,
    sha256: row.sha256,
  };
}

async function pullRequestsForBuilds(database: D1Database, ids: string[]): Promise<Map<string, PreviewPullRequest[]>> {
  const result = new Map<string, PreviewPullRequest[]>();
  for (const id of ids) result.set(id, []);
  if (!ids.length) return result;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await database.prepare(
    `SELECT build_id, pr_number, title, url, base_branch FROM preview_build_prs WHERE build_id IN (${placeholders}) ORDER BY pr_number`,
  ).bind(...ids).all<PullRequestRow>();
  for (const row of rows.results) result.get(row.build_id)?.push(toPullRequest(row));
  return result;
}

async function getBuild(database: D1Database, id: string, includeUnavailable = false): Promise<PreviewBuild | null> {
  const availability = includeUnavailable ? "" : "AND status = 'ready' AND expires_at > ?";
  const statement = database.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM preview_assets a WHERE a.build_id = b.id) AS asset_count
    FROM preview_builds b WHERE id = ? ${availability}
  `);
  const row = includeUnavailable
    ? await statement.bind(id).first<BuildRow>()
    : await statement.bind(id, Math.floor(Date.now() / 1000)).first<BuildRow>();
  if (!row) return null;
  const [pullRequests, assets] = await Promise.all([
    pullRequestsForBuilds(database, [id]),
    database.prepare("SELECT * FROM preview_assets WHERE build_id = ? ORDER BY variant").bind(id).all<AssetRow>(),
  ]);
  return { ...toSummary(row, pullRequests.get(id) || []), assets: assets.results.map(toAsset) };
}

function parseCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))) as unknown;
    if (!isRecord(decoded) || !Number.isSafeInteger(decoded.publishedAt) || !isSafeText(decoded.id, 64)) return null;
    return { publishedAt: Number(decoded.publishedAt), id: decoded.id };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function listPreviews(request: Request, env: PreviewEnv): Promise<Response> {
  if (!env.PREVIEWS) return invalid("Preview storage is not configured.", 503);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const kind = (url.searchParams.get("kind") || "all") as PreviewKind;
  const prText = url.searchParams.get("pr") || "";
  const branch = (url.searchParams.get("branch") || "").trim();
  const commit = (url.searchParams.get("commit") || "").trim().toLowerCase();
  const limitText = url.searchParams.get("limit") || String(DEFAULT_LIMIT);
  const cursorText = url.searchParams.get("cursor");
  const limit = Number(limitText);
  const cursor = parseCursor(cursorText);

  if (!["all", "pr", "main"].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT ||
      q.length > 200 || branch.length > 255 || (prText && (!/^\d+$/.test(prText) || Number(prText) <= 0)) ||
      (commit && !/^[0-9a-f]{4,40}$/.test(commit)) || (cursorText && !cursor)) {
    return invalid("Invalid preview query.");
  }

  const conditions = ["b.status = 'ready'", "b.expires_at > ?"];
  const bindings: Array<string | number> = [Math.floor(Date.now() / 1000)];
  if (kind === "pr") conditions.push("EXISTS (SELECT 1 FROM preview_build_prs kp WHERE kp.build_id = b.id)");
  if (kind === "main") conditions.push("b.event = 'push' AND b.branch = 'main'");
  if (prText) {
    conditions.push("EXISTS (SELECT 1 FROM preview_build_prs fp WHERE fp.build_id = b.id AND fp.pr_number = ?)");
    bindings.push(Number(prText));
  }
  if (branch) {
    conditions.push("b.branch = ? COLLATE NOCASE");
    bindings.push(branch);
  }
  if (commit) {
    conditions.push("b.commit_sha LIKE ?");
    bindings.push(`${commit}%`);
  }
  if (q) {
    conditions.push(`(
      b.branch LIKE ? ESCAPE '\\' OR b.actor LIKE ? ESCAPE '\\' OR b.commit_sha LIKE ? ESCAPE '\\' OR
      EXISTS (SELECT 1 FROM preview_build_prs qp WHERE qp.build_id = b.id AND
        (CAST(qp.pr_number AS TEXT) LIKE ? ESCAPE '\\' OR qp.title LIKE ? ESCAPE '\\'))
    )`);
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (cursor) {
    conditions.push("(b.published_at < ? OR (b.published_at = ? AND b.id < ?))");
    bindings.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }

  const rows = await env.PREVIEWS.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM preview_assets a WHERE a.build_id = b.id) AS asset_count
    FROM preview_builds b
    WHERE ${conditions.join(" AND ")}
    ORDER BY b.published_at DESC, b.id DESC
    LIMIT ?
  `).bind(...bindings, limit + 1).all<BuildRow>();
  const page = rows.results.slice(0, limit);
  const pullRequests = await pullRequestsForBuilds(env.PREVIEWS, page.map((row) => row.id));
  const items = page.map((row) => toSummary(row, pullRequests.get(row.id) || []));
  const last = page.at(-1);
  return json({
    items,
    nextCursor: rows.results.length > limit && last
      ? encodeCursor({ publishedAt: last.published_at || last.created_at, id: last.id })
      : null,
  }, {
    headers: { "Cache-Control": "public, max-age=15, s-maxage=30", "Cloudflare-CDN-Cache-Control": "public, max-age=30" },
  });
}

async function readUpload(request: Request): Promise<{ metadata: PreviewUploadMetadata; files: Map<string, Uint8Array> }> {
  const form = await request.formData();
  const rawMetadata = form.get("metadata");
  if (typeof rawMetadata !== "string") throw new Error("The metadata field is required.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawMetadata);
  } catch {
    throw new Error("The metadata field is not valid JSON.");
  }
  const metadata = parsePreviewMetadata(decoded);
  const files = new Map<string, Uint8Array>();
  for (const asset of metadata.assets) {
    const entry = form.get(`asset:${asset.variant}`);
    if (!entry || typeof entry === "string") throw new Error(`Missing ${asset.filename}.`);
    if (entry.name !== asset.filename || entry.size !== asset.size) throw new Error(`File metadata does not match ${asset.filename}.`);
    const bytes = new Uint8Array(await entry.arrayBuffer());
    await validatePreviewAssetBytes(asset, bytes);
    files.set(asset.variant, bytes);
  }
  return { metadata, files };
}

async function uploadPreview(request: Request, env: PreviewEnv): Promise<Response> {
  const trust = githubOidcTrustFromEnv(env);
  if (!trust) return invalid("Preview OIDC trust is not configured.", 503);
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !await verifyGitHubOidcToken(token, trust)) {
    return invalid("Unauthorized.", 401);
  }
  if (!env.PREVIEWS || !env.RELEASE_ASSETS) return invalid("Preview storage is not configured.", 503);

  let upload: Awaited<ReturnType<typeof readUpload>>;
  try {
    upload = await readUpload(request);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid preview upload.");
  }
  const { metadata, files } = upload;
  if (String(metadata.repositoryId) !== trust.repositoryId) {
    return invalid("Preview metadata does not match the authenticated repository.");
  }
  const buildId = `${metadata.runId}:${metadata.runAttempt}`;
  const canonical = canonicalMetadata(metadata);
  const existing = await env.PREVIEWS.prepare("SELECT * FROM preview_builds WHERE id = ?").bind(buildId).first<BuildRow>();
  if (existing && existing.metadata_json !== canonical) return invalid("This workflow run already has different metadata.", 409);
  if (existing?.status === "ready") {
    const build = await getBuild(env.PREVIEWS, buildId);
    return json(build, { status: 200 });
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + RETENTION_SECONDS;
  const statements: D1PreparedStatement[] = [];
  if (existing?.status === "failed") {
    statements.push(env.PREVIEWS.prepare("DELETE FROM preview_assets WHERE build_id = ?").bind(buildId));
    statements.push(env.PREVIEWS.prepare("DELETE FROM preview_build_prs WHERE build_id = ?").bind(buildId));
    statements.push(env.PREVIEWS.prepare(`
      UPDATE preview_builds SET status = 'uploading', error = NULL, expires_at = ? WHERE id = ?
    `).bind(expiresAt, buildId));
  } else if (!existing) {
    statements.push(env.PREVIEWS.prepare(`
      INSERT INTO preview_builds
        (id, run_id, run_attempt, event, status, commit_sha, branch, actor, run_url, repository,
         source_repository, metadata_json, created_at, published_at, expires_at)
      VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
      buildId, metadata.runId, metadata.runAttempt, metadata.event, metadata.commitSha, metadata.branch,
      metadata.actor, metadata.runUrl, metadata.repository, metadata.sourceRepository, canonical,
      Math.floor(new Date(metadata.createdAt).getTime() / 1000), expiresAt,
    ));
  }
  for (const pullRequest of metadata.pullRequests) {
    statements.push(env.PREVIEWS.prepare(`
      INSERT INTO preview_build_prs (build_id, pr_number, title, url, base_branch) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (build_id, pr_number) DO UPDATE SET
        title = excluded.title, url = excluded.url, base_branch = excluded.base_branch
    `).bind(buildId, pullRequest.number, pullRequest.title, pullRequest.url, pullRequest.baseBranch));
  }
  for (const asset of metadata.assets) {
    statements.push(env.PREVIEWS.prepare(`
      INSERT INTO preview_assets (build_id, variant, filename, size, sha256, r2_key) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (build_id, variant) DO UPDATE SET
        filename = excluded.filename, size = excluded.size, sha256 = excluded.sha256, r2_key = excluded.r2_key
    `).bind(buildId, asset.variant, asset.filename, asset.size, asset.sha256, previewStorageKey(metadata, asset.variant, asset.sha256)));
  }
  if (statements.length) await env.PREVIEWS.batch(statements);

  try {
    for (const asset of metadata.assets) {
      const bytes = files.get(asset.variant);
      if (!bytes) throw new Error(`Missing ${asset.filename}.`);
      await env.RELEASE_ASSETS.put(previewStorageKey(metadata, asset.variant, asset.sha256), bytes, {
        sha256: Uint8Array.from(asset.sha256.match(/../g) || [], (value) => Number.parseInt(value, 16)).buffer,
        httpMetadata: {
          contentType: "application/octet-stream",
          contentDisposition: `attachment; filename="${asset.filename}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
          cacheControl: "public, max-age=60",
        },
        customMetadata: { buildId, filename: asset.filename, sha256: asset.sha256, variant: asset.variant },
      });
    }
    await env.PREVIEWS.prepare(`
      UPDATE preview_builds SET status = 'ready', published_at = ?, error = NULL WHERE id = ? AND status = 'uploading'
    `).bind(now, buildId).run();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Asset upload failed.";
    await env.PREVIEWS.prepare("UPDATE preview_builds SET status = 'failed', error = ? WHERE id = ?")
      .bind(message, buildId).run();
    return invalid("Preview storage failed.", 502);
  }

  return json(await getBuild(env.PREVIEWS, buildId), { status: 201 });
}

async function servePreviewAsset(env: PreviewEnv, assetId: number): Promise<Response> {
  if (!env.PREVIEWS || !env.RELEASE_ASSETS) return invalid("Preview storage is not configured.", 503);
  if (!publicAssetUrl(env.ASSET_PUBLIC_BASE_URL, "previews/test")) return invalid("Public asset storage is not configured.", 503);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return invalid("Invalid preview asset.");
  const row = await env.PREVIEWS.prepare(`
    SELECT a.* FROM preview_assets a JOIN preview_builds b ON b.id = a.build_id
    WHERE a.id = ? AND b.status = 'ready' AND b.expires_at > ?
  `).bind(assetId, Math.floor(Date.now() / 1000)).first<AssetRow>();
  if (!row) return invalid("Preview asset not found.", 404);
  return assetRedirect(env.ASSET_PUBLIC_BASE_URL, row.r2_key, "public, max-age=60, s-maxage=60")!;
}

async function listPreviewStorage(request: Request, env: PreviewEnv): Promise<Response> {
  if (!env.PREVIEWS || !env.RELEASE_ASSETS) return invalid("Preview storage is not configured.", 503);
  if (!publicAssetUrl(env.ASSET_PUBLIC_BASE_URL, "previews/test")) return invalid("Public asset storage is not configured.", 503);
  const url = new URL(request.url);
  const query = parseStorageListQuery(url);
  const buildId = (url.searchParams.get("buildId") || "").trim();
  if (!query || (buildId && !/^[0-9]+:[0-9]+$/.test(buildId))) return invalid("Invalid storage inventory query.");

  const [runId, runAttempt] = buildId ? buildId.split(":") : [];
  const prefix = buildId ? `previews/${runId}/${runAttempt}/` : "previews/";
  try {
    const listed = await listStorageObjects(env.RELEASE_ASSETS, env.ASSET_PUBLIC_BASE_URL!, prefix, query);
    if (!listed.objects.length) return json({ items: [], nextCursor: listed.nextCursor }, {
      headers: { "Cache-Control": "public, max-age=15, s-maxage=30" },
    });

    const placeholders = listed.objects.map(() => "?").join(",");
    const rows = await env.PREVIEWS.prepare(`
      SELECT
        b.*,
        (SELECT COUNT(*) FROM preview_assets c WHERE c.build_id = b.id) AS asset_count,
        a.id AS asset_id,
        a.build_id AS asset_build_id,
        a.variant AS asset_variant,
        a.filename AS asset_filename,
        a.size AS asset_size,
        a.sha256 AS asset_sha256,
        a.r2_key AS asset_storage_key
      FROM preview_assets a
      JOIN preview_builds b ON b.id = a.build_id
      WHERE a.r2_key IN (${placeholders}) AND b.status = 'ready' AND b.expires_at > ?
    `).bind(...listed.objects.map((object) => object.key), Math.floor(Date.now() / 1000)).all<PreviewInventoryRow>();
    const buildIds = [...new Set(rows.results.map((row) => row.id))];
    const pullRequests = await pullRequestsForBuilds(env.PREVIEWS, buildIds);
    const byKey = new Map(rows.results.map((row) => [row.asset_storage_key, row]));
    const items = listed.objects.flatMap((object) => {
      const row = byKey.get(object.key);
      if (!row) return [];
      return [{
        object,
        asset: {
          ...toAsset({
            id: row.asset_id,
            build_id: row.asset_build_id,
            variant: row.asset_variant,
            filename: row.asset_filename,
            size: row.asset_size,
            sha256: row.asset_sha256,
            r2_key: row.asset_storage_key,
          }),
          storageKey: row.asset_storage_key,
        },
        build: {
          ...toSummary(row, pullRequests.get(row.id) || []),
          status: "ready" as const,
        },
      }];
    });
    return json({ items, nextCursor: listed.nextCursor }, {
      headers: { "Cache-Control": "public, max-age=15, s-maxage=30" },
    });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Storage inventory is unavailable.", 502);
  }
}

export async function handlePreviewRequest(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/previews") {
    if (request.method === "POST") return uploadPreview(request, env);
    if (request.method === "GET") return listPreviews(request, env);
    return invalid("Method not allowed.", 405);
  }
  const encodedBuildMatch = url.pathname.match(/^\/api\/previews\/([^/]+)$/);
  let buildId: string | null = null;
  if (encodedBuildMatch) {
    try {
      const decoded = decodeURIComponent(encodedBuildMatch[1]);
      if (/^[0-9]+:[0-9]+$/.test(decoded)) buildId = decoded;
    } catch {
      // Ignore malformed path encoding and let the general API router return 404.
    }
  }
  if (buildId && request.method === "GET") {
    if (!env.PREVIEWS) return invalid("Preview storage is not configured.", 503);
    const build = await getBuild(env.PREVIEWS, buildId);
    return build ? json(build, { headers: { "Cache-Control": "public, max-age=15, s-maxage=30" } }) : invalid("Preview build not found.", 404);
  }
  const assetMatch = url.pathname.match(/^\/api\/preview-assets\/(\d+)$/);
  if (assetMatch && request.method === "GET") return servePreviewAsset(env, Number(assetMatch[1]));
  if (url.pathname === "/api/storage/previews" && request.method === "GET") return listPreviewStorage(request, env);
  return null;
}

export async function cleanupPreviews(env: PreviewEnv): Promise<void> {
  if (!env.PREVIEWS || !env.RELEASE_ASSETS) return;
  const expired = await env.PREVIEWS.prepare(
    "SELECT id FROM preview_builds WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
  ).bind(Math.floor(Date.now() / 1000)).all<{ id: string }>();
  if (!expired.results.length) return;
  const ids = expired.results.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const assets = await env.PREVIEWS.prepare(
    `SELECT r2_key FROM preview_assets WHERE build_id IN (${placeholders})`,
  ).bind(...ids).all<{ r2_key: string }>();
  if (assets.results.length) await env.RELEASE_ASSETS.delete(assets.results.map((row) => row.r2_key));
  await env.PREVIEWS.prepare(`DELETE FROM preview_builds WHERE id IN (${placeholders})`).bind(...ids).run();
}

export { previewStorageKey };
