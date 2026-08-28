import { describe, expect, it } from "vitest";
import { assetUrl, sha256Hex } from "../lib/assets";
import { PREVIEW_VARIANTS, previewAssetFilename, type PreviewUploadMetadata } from "../lib/previews";
import { encodeUf2 } from "../lib/uf2";
import {
  handlePreviewRequest,
  parsePreviewMetadata,
  previewR2Key,
  validatePreviewAssetBytes,
} from "../worker/previews";

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

  it("requires the bearer token before storage access", async () => {
    const response = await handlePreviewRequest(
      new Request("https://flasher.test/api/previews", { method: "POST" }),
      { RS_KEY_FLASHER_UPLOAD_TOKEN: "secret" },
    );
    expect(response?.status).toBe(401);
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
