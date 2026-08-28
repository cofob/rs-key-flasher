import { describe, expect, it } from "vitest";
import {
  firmwareAssets,
  firmwareProfiles,
  findOfficialAssetBySha256,
  parseFirmwareAsset,
  recommendVariant,
  releaseManifestFromGitHub,
} from "../lib/releases";

describe("release asset parsing", () => {
  const asset = {
    id: 1,
    name: "rs-key-v0.4.10-strong-pin-pqc.uf2",
    size: 1024,
    sha256: "a".repeat(64),
  };

  it("separates the release version and full variant name", () => {
    expect(parseFirmwareAsset(asset, "v0.4.10")).toMatchObject({
      version: "0.4.10",
      variant: "strong-pin-pqc",
    });
  });

  it("ignores non-firmware assets", () => {
    expect(parseFirmwareAsset({ ...asset, name: "SHA256SUMS" }, "v0.4.10")).toBeNull();
    expect(firmwareAssets({
      id: 10,
      tag: "v0.4.10",
      name: "release",
      publishedAt: "",
      prerelease: false,
      immutable: true,
      assets: [asset, { ...asset, id: 2, name: "SHA256SUMS" }],
    })).toHaveLength(1);
  });

  it("maps easy-picker answers to geometry variants", () => {
    expect(recommendVariant(true, "4")).toBe("display");
    expect(recommendVariant(false, "2")).toBe("2mb");
    expect(recommendVariant(false, "16")).toBe("16mb");
    expect(recommendVariant(false, "4")).toBe("default");
    expect(recommendVariant(false, "4", "fips-pqc")).toBe("fips-pqc");
  });

  it("lists policy profiles without geometry-only variants", () => {
    const assets = ["default", "display", "16mb", "fips", "fips-pqc"].map((variant, index) => ({
      ...asset,
      source: "release" as const,
      id: index,
      name: `rs-key-v0.4.10-${variant}.uf2`,
      tag: "v0.4.10",
      version: "0.4.10",
      variant,
    }));
    expect(firmwareProfiles(assets)).toEqual(["default", "fips", "fips-pqc"]);
  });

  it("finds a local UF2 digest in all official release assets", () => {
    const release = {
      id: 10,
      tag: "v0.4.10",
      name: "release",
      publishedAt: "",
      prerelease: false,
      immutable: true,
      assets: [asset],
    };
    expect(findOfficialAssetBySha256([release], asset.sha256)).toEqual({ tag: "v0.4.10", asset });
    expect(findOfficialAssetBySha256([release], "f".repeat(64))).toBeUndefined();
  });

  it("converts the direct GitHub response and keeps its download URL", () => {
    const manifest = releaseManifestFromGitHub([{
      id: 100,
      tag_name: "v0.4.10",
      name: "RS-Key 0.4.10",
      published_at: "2026-01-01T00:00:00Z",
      prerelease: false,
      draft: false,
      immutable: true,
      assets: [{
        id: 17,
        name: "rs-key-v0.4.10-default.uf2",
        size: 4096,
        digest: `sha256:${"A".repeat(64)}`,
        browser_download_url: "https://github.com/TheMaxMur/RS-Key/releases/download/v0.4.10/rs-key-v0.4.10-default.uf2",
      }, {
        id: 18,
        name: "old.uf2",
        size: 4096,
        digest: null,
        browser_download_url: "https://example.invalid/old.uf2",
      }],
    }], "2026-01-02T00:00:00Z");

    expect(manifest).toMatchObject({ refreshedAt: "2026-01-02T00:00:00Z", stale: false });
    expect(manifest.releases[0].assets).toEqual([{
      id: 17,
      name: "rs-key-v0.4.10-default.uf2",
      size: 4096,
      sha256: "a".repeat(64),
      downloadUrl: "https://github.com/TheMaxMur/RS-Key/releases/download/v0.4.10/rs-key-v0.4.10-default.uf2",
    }]);
  });
});
