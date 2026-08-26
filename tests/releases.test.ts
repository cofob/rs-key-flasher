import { describe, expect, it } from "vitest";
import { firmwareAssets, parseFirmwareAsset, recommendVariant } from "../lib/releases";

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
      tag: "v0.4.10",
      name: "release",
      publishedAt: "",
      prerelease: false,
      assets: [asset, { ...asset, id: 2, name: "SHA256SUMS" }],
    })).toHaveLength(1);
  });

  it("maps easy-picker answers to geometry variants", () => {
    expect(recommendVariant(true, "4")).toBe("display");
    expect(recommendVariant(false, "2")).toBe("2mb");
    expect(recommendVariant(false, "16")).toBe("16mb");
    expect(recommendVariant(false, "4")).toBe("default");
  });
});
