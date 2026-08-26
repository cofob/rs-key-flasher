export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  sha256: string;
}

export interface Release {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ReleaseManifest {
  refreshedAt: string;
  stale: boolean;
  releases: Release[];
}

export interface FirmwareAsset extends ReleaseAsset {
  tag: string;
  version: string;
  variant: string;
}

export function parseFirmwareAsset(asset: ReleaseAsset, tag: string): FirmwareAsset | null {
  const prefix = `rs-key-${tag}-`;
  const suffix = ".uf2";
  if (!asset.name.startsWith(prefix) || !asset.name.endsWith(suffix)) return null;

  const variant = asset.name.slice(prefix.length, -suffix.length);
  if (!variant) return null;

  return {
    ...asset,
    tag,
    version: tag.startsWith("v") ? tag.slice(1) : tag,
    variant,
  };
}

export function firmwareAssets(release: Release): FirmwareAsset[] {
  return release.assets
    .map((asset) => parseFirmwareAsset(asset, release.tag))
    .filter((asset): asset is FirmwareAsset => asset !== null)
    .sort((a, b) => a.variant.localeCompare(b.variant));
}

export function recommendVariant(hasDisplay: boolean, flashSize: string): string {
  if (hasDisplay) return "display";
  if (flashSize === "2") return "2mb";
  if (flashSize === "16") return "16mb";
  return "default";
}

const VARIANT_LABELS: Record<string, string> = {
  default: "Standard · 4 MB",
  "2mb": "Standard · 2 MB",
  "16mb": "Standard · 16 MB",
  display: "Waveshare touch display · 16 MB",
  pqc: "Post-quantum algorithms",
  fips: "FIPS-style policy",
  "fips-pqc": "FIPS-style policy + post-quantum",
  "strong-pin": "Strong PIN policy",
  "strong-pin-pqc": "Strong PIN + post-quantum",
  "always-uv": "Always require PIN",
  "always-uv-pqc": "Always require PIN + post-quantum",
  "strict-up": "Strict touch policy",
  "strict-up-pqc": "Strict touch + post-quantum",
  "strict-config": "Strict configuration writes",
};

export function variantLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant;
}
