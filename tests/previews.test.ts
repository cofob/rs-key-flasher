import { describe, expect, it, vi } from "vitest";
import { assetUrl } from "../lib/assets";
import { PREVIEW_VARIANTS, previewAssetFilename, type PreviewUploadMetadata } from "../lib/previews";
import { type GitHubOidcTrust, verifyGitHubOidcToken } from "../worker/github-oidc";
import {
  cleanupArchivedPreview,
  enqueuePreviewArchive,
  handlePreviewRequest,
  parsePreviewMetadata,
  parsePreviewUploadForm,
  previewStorageKey,
  reconcilePreviewArchives,
} from "../worker/previews";

const OIDC_TRUST: GitHubOidcTrust = {
  audience: "https://rskey.fob.wtf/api/previews",
  repositoryId: "1266469959",
  workflowRef: "TheMaxMur/RS-Key/.github/workflows/preview-publish.yml@refs/heads/main",
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedOidcToken(overrides: Record<string, unknown> = {}): Promise<{ token: string; jwk: JsonWebKey }> {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(jwk, { alg: "RS256", kid: "test-key", use: "sig" });
  const now = Math.floor(Date.now() / 1000);
  const header = jsonSegment({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = jsonSegment({
    iss: "https://token.actions.githubusercontent.com",
    aud: OIDC_TRUST.audience,
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    repository_id: OIDC_TRUST.repositoryId,
    workflow_ref: OIDC_TRUST.workflowRef,
    event_name: "workflow_run",
    ...overrides,
  });
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, signingInput));
  return { token: `${header}.${claims}.${base64Url(signature)}`, jwk };
}

function metadata(): PreviewUploadMetadata {
  return {
    schemaVersion: 1,
    repository: "TheMaxMur/RS-Key",
    repositoryId: 1266469959,
    event: "pull_request",
    runId: 123,
    runAttempt: 2,
    runUrl: "https://github.com/TheMaxMur/RS-Key/actions/runs/123",
    commitSha: "a".repeat(40),
    branch: "preview/api",
    actor: "contributor",
    sourceRepository: "contributor/RS-Key",
    createdAt: "2026-08-28T12:00:00.000Z",
    pullRequests: [{
      number: 16,
      title: "Preview API",
      url: "https://github.com/TheMaxMur/RS-Key/pull/16",
      baseBranch: "main",
    }],
    assets: PREVIEW_VARIANTS.map((variant) => ({
      variant,
      filename: previewAssetFilename(variant),
      size: 512,
      sha256: "b".repeat(64),
    })),
  };
}

describe("preview upload contract", () => {
  it("accepts all 20 safe variants and keeps CI run metadata", () => {
    const parsed = parsePreviewMetadata(metadata());
    expect(parsed.assets).toHaveLength(20);
    expect(parsed.runId).toBe(123);
    expect(parsed.runAttempt).toBe(2);
    expect(parsed.runUrl).toContain("/actions/runs/123");
  });

  it("rejects incomplete and no-touch upload sets", () => {
    expect(() => parsePreviewMetadata({ ...metadata(), assets: metadata().assets.slice(1) }))
      .toThrow("complete set");
    const withNoTouch = metadata();
    withNoTouch.assets[0] = {
      variant: "no-touch" as never,
      filename: "firmware-no-touch.uf2",
      size: 512,
      sha256: "b".repeat(64),
    };
    expect(() => parsePreviewMetadata(withNoTouch)).toThrow("Invalid preview asset metadata");
  });

  it("uses deterministic storage paths", () => {
    expect(previewStorageKey(metadata(), "default", "c".repeat(64)))
      .toBe(`previews/123/2/${"c".repeat(64)}-default.uf2`);
  });

  it("keeps upload files as blobs without copying their bytes", () => {
    const upload = metadata();
    const form = new FormData();
    form.set("metadata", JSON.stringify(upload));
    const files = new Map<string, File>();
    for (const asset of upload.assets) {
      const file = new File([new Uint8Array(asset.size)], asset.filename);
      files.set(asset.variant, file);
      form.set(`asset:${asset.variant}`, file);
    }
    const arrayBuffer = vi.spyOn(files.get("default")!, "arrayBuffer");

    const parsed = parsePreviewUploadForm(form);

    expect(parsed.files.get("default")).toBe(files.get("default"));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects the removed shared-token authentication before storage access", async () => {
    const response = await handlePreviewRequest(
      new Request("https://flasher.test/api/previews", {
        method: "POST",
        headers: { Authorization: "Bearer old-shared-token" },
      }),
      {
        GITHUB_OIDC_AUDIENCE: OIDC_TRUST.audience,
        GITHUB_OIDC_REPOSITORY_ID: OIDC_TRUST.repositoryId,
        GITHUB_OIDC_WORKFLOW_REF: OIDC_TRUST.workflowRef,
      },
    );
    expect(response?.status).toBe(401);
  });

  it("routes percent-encoded preview build IDs", async () => {
    const response = await handlePreviewRequest(
      new Request("https://flasher.test/api/previews/33266729700%3A1"),
      {},
    );
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: "Preview storage is not configured." });
  });

  it("verifies GitHub OIDC signature and publisher identity", async () => {
    const valid = await signedOidcToken();
    const loadKeys = async () => [valid.jwk];
    await expect(verifyGitHubOidcToken(valid.token, OIDC_TRUST, loadKeys)).resolves.toBe(true);

    const wrongRepository = await signedOidcToken({ repository_id: "999" });
    await expect(verifyGitHubOidcToken(wrongRepository.token, OIDC_TRUST, async () => [wrongRepository.jwk]))
      .resolves.toBe(false);
    const wrongAudience = await signedOidcToken({ aud: "https://example.test/previews" });
    await expect(verifyGitHubOidcToken(wrongAudience.token, OIDC_TRUST, async () => [wrongAudience.jwk]))
      .resolves.toBe(false);
    const expired = await signedOidcToken({ exp: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifyGitHubOidcToken(expired.token, OIDC_TRUST, async () => [expired.jwk]))
      .resolves.toBe(false);
    await expect(verifyGitHubOidcToken(valid.token, { ...OIDC_TRUST, workflowRef: "untrusted" }, loadKeys))
      .resolves.toBe(false);
  });

  it("routes preview assets by their source type", () => {
    expect(assetUrl({
      source: "preview",
      id: 77,
      buildId: "123:2",
      commitSha: "a".repeat(40),
      name: "firmware-default.uf2",
      size: 512,
      sha256: "b".repeat(64),
      variant: "default",
      version: "aaaaaaaaaaaa",
    })).toBe("/api/preview-assets/77");

    expect(assetUrl({
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
        size: 1024,
        uncompressedSize: 10_240,
        sha256: "c".repeat(64),
        archivedAt: "2026-08-29T12:00:00.000Z",
        downloadUrl: "/api/preview-archives/123%3A2",
      },
    })).toBe("/api/preview-archives/123%3A2");
  });

  it("redirects a ready preview asset without a storage metadata check", async () => {
    const row = {
      id: 77,
      build_id: "123:2",
      variant: "default",
      filename: "firmware-default.uf2",
      size: 512,
      sha256: "b".repeat(64),
      r2_key: `previews/123/2/${"b".repeat(64)}-default.uf2`,
    };
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    };
    const bucket = {
      head: vi.fn(),
    };

    const response = await handlePreviewRequest(
      new Request("https://flasher.test/api/preview-assets/77"),
      { PREVIEWS: database, RELEASE_ASSETS: bucket, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location"))
      .toBe(`https://assets.test/previews/123/2/${"b".repeat(64)}-default.uf2`);
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it("returns only public database-linked objects from preview inventory", async () => {
    const now = Math.floor(Date.now() / 1000);
    const object = (key: string) => ({
      key,
      version: "v1",
      size: 512,
      etag: "etag",
      uploaded: new Date("2026-08-29T12:00:00.000Z"),
      storageClass: "Standard",
      checksums: {},
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: "b".repeat(64) },
    });
    const publicKey = `previews/123/2/${"b".repeat(64)}-default.uf2`;
    const orphanKey = "previews/999/1/orphan.uf2";
    const bucket = {
      list: async () => ({ objects: [object(publicKey), object(orphanKey)], truncated: false }),
    };
    const joinedRow = {
      id: "123:2",
      run_id: 123,
      run_attempt: 2,
      event: "pull_request",
      status: "ready",
      commit_sha: "a".repeat(40),
      branch: "preview/api",
      actor: "contributor",
      run_url: "https://github.com/TheMaxMur/RS-Key/actions/runs/123",
      repository: "TheMaxMur/RS-Key",
      source_repository: "contributor/RS-Key",
      metadata_json: "private raw metadata",
      created_at: now - 60,
      published_at: now,
      expires_at: now + 3600,
      error: "private error",
      asset_count: 1,
      asset_id: 77,
      asset_build_id: "123:2",
      asset_variant: "default",
      asset_filename: "firmware-default.uf2",
      asset_size: 512,
      asset_sha256: "b".repeat(64),
      asset_storage_key: publicKey,
    };
    const database = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => sql.includes("FROM preview_build_prs")
            ? { results: [] }
            : { results: [joinedRow] },
        }),
      }),
    };

    const response = await handlePreviewRequest(
      new Request("https://flasher.test/api/storage/previews?limit=2"),
      { PREVIEWS: database, RELEASE_ASSETS: bucket, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
    );
    const body = await response?.json() as { items: Array<Record<string, unknown>> };

    expect(response?.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("private raw metadata");
    expect(JSON.stringify(body)).not.toContain("private error");
    expect(body.items[0]).toMatchObject({
      object: { key: publicKey },
      asset: { id: 77, storageKey: publicKey },
      build: { id: "123:2", status: "ready" },
    });
  });

  it("redirects an archive and returns 410 after legacy cleanup", async () => {
    const archiveKey = `previews/123/2/${"c".repeat(64)}-previews.tar.zst`;
    const archiveRow = {
      build_id: "123:2",
      filename: "preview-123-2.tar.zst",
      size: 1024,
      uncompressed_size: 10_240,
      sha256: "c".repeat(64),
      r2_key: archiveKey,
      archived_at: 1,
      legacy_delete_after: 2,
      legacy_deleted_at: 3,
    };
    const archiveDatabase = {
      prepare: () => ({ bind: () => ({ first: async () => archiveRow }) }),
    };
    const archiveResponse = await handlePreviewRequest(
      new Request("https://flasher.test/api/preview-archives/123%3A2"),
      { PREVIEWS: archiveDatabase, RELEASE_ASSETS: {}, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
    );
    expect(archiveResponse?.status).toBe(307);
    expect(archiveResponse?.headers.get("Location")).toBe(`https://assets.test/${archiveKey}`);

    const deletedDatabase = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        id: 77,
        build_id: "123:2",
        variant: "default",
        filename: "firmware-default.uf2",
        size: 512,
        sha256: "b".repeat(64),
        r2_key: null,
        archive_build_id: "123:2",
      }) }) }),
    };
    const deletedResponse = await handlePreviewRequest(
      new Request("https://flasher.test/api/preview-assets/77"),
      { PREVIEWS: deletedDatabase, RELEASE_ASSETS: {}, ASSET_PUBLIC_BASE_URL: "https://assets.test" } as never,
    );
    expect(deletedResponse?.status).toBe(410);
  });

  it("queues missing archives and due legacy cleanup work", async () => {
    const sent: unknown[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: sql.includes("LEFT JOIN preview_archives")
            ? [{ id: "123:2" }]
            : [{ id: "124:1" }] }),
        }),
      }),
    };
    await reconcilePreviewArchives({
      PREVIEWS: database,
      PREVIEW_TASKS: { sendBatch: async (messages: unknown[]) => sent.push(...messages) },
    } as never);
    expect(sent).toEqual([
      { body: { schemaVersion: 1, type: "archive-preview", buildId: "123:2" } },
      { body: { schemaVersion: 1, type: "cleanup-preview", buildId: "124:1" } },
    ]);
  });

  it("creates an immediate archive queue message", async () => {
    const send = vi.fn();
    await enqueuePreviewArchive({ PREVIEW_TASKS: { send } } as never, "123:2");
    expect(send).toHaveBeenCalledWith(
      { schemaVersion: 1, type: "archive-preview", buildId: "123:2" },
      undefined,
    );
  });

  it("deletes individual objects and keeps logical asset metadata", async () => {
    const deleted: string[][] = [];
    const batches: unknown[][] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes("preview_archives") ? {
            build_id: "123:2",
            filename: "preview.tar.zst",
            size: 100,
            uncompressed_size: 1024,
            sha256: "c".repeat(64),
            r2_key: "archive",
            archived_at: 1,
            legacy_delete_after: 1,
            legacy_deleted_at: null,
          } : null,
          all: async () => ({ results: [{ r2_key: "first.uf2" }, { r2_key: "second.uf2" }] }),
        }),
      }),
      batch: async (statements: unknown[]) => batches.push(statements),
    };
    await cleanupArchivedPreview({
      PREVIEWS: database,
      RELEASE_ASSETS: { delete: async (keys: string[]) => deleted.push(keys) },
    } as never, "123:2");
    expect(deleted).toEqual([["first.uf2", "second.uf2"]]);
    expect(batches).toHaveLength(1);
  });
});
