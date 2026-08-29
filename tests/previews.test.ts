import { describe, expect, it } from "vitest";
import { assetUrl, sha256Hex } from "../lib/assets";
import { PREVIEW_VARIANTS, previewAssetFilename, type PreviewUploadMetadata } from "../lib/previews";
import { encodeUf2 } from "../lib/uf2";
import { type GitHubOidcTrust, verifyGitHubOidcToken } from "../worker/github-oidc";
import {
  handlePreviewRequest,
  parsePreviewMetadata,
  previewR2Key,
  validatePreviewAssetBytes,
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

  it("uses deterministic R2 paths", () => {
    expect(previewR2Key(metadata(), "default", "c".repeat(64)))
      .toBe(`previews/123/2/${"c".repeat(64)}-default.uf2`);
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

  it("checks SHA-256, UF2 structure, and the RP2350 secure family", async () => {
    const bytes = encodeUf2({
      familyId: 0xe48bff59,
      familyName: "RP2350 Arm Secure",
      productId: 0x000f,
      totalBytes: 256,
      segments: [{ address: 0x10000000, data: new Uint8Array(256) }],
    });
    const asset = { ...metadata().assets[0], size: bytes.length, sha256: await sha256Hex(bytes) };
    await expect(validatePreviewAssetBytes(asset, bytes)).resolves.toBeUndefined();
    await expect(validatePreviewAssetBytes({ ...asset, sha256: "0".repeat(64) }, bytes)).rejects.toThrow("SHA-256");

    const nonSecure = encodeUf2({
      familyId: 0xe48bff5b,
      familyName: "RP2350 Arm Non-secure",
      productId: 0x000f,
      totalBytes: 256,
      segments: [{ address: 0x10000000, data: new Uint8Array(256) }],
    });
    await expect(validatePreviewAssetBytes({ ...asset, sha256: await sha256Hex(nonSecure) }, nonSecure))
      .rejects.toThrow("RP2350 Arm Secure");
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
  });
});
