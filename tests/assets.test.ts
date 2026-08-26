import { describe, expect, it } from "vitest";
import { assetUrl } from "../lib/assets";
import type { FirmwareAsset } from "../lib/releases";

const asset: FirmwareAsset = {
  id: 42,
  name: "rs-key-v1.0.0-fips-pqc.uf2",
  size: 8192,
  sha256: "b".repeat(64),
  tag: "v1.0.0",
  version: "1.0.0",
  variant: "fips-pqc",
};

describe("firmware asset URL", () => {
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
});
