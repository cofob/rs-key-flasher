export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  sha256: string;
  downloadUrl?: string;
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

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubAsset[];
}

export function releaseManifestFromGitHub(raw: unknown, refreshedAt = new Date().toISOString()): ReleaseManifest {
  if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid release list.");
  const releases = (raw as GitHubRelease[]).filter((release) => !release.draft).map((release): Release => ({
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at || "",
    prerelease: release.prerelease,
    assets: Array.isArray(release.assets) ? release.assets.flatMap((asset): ReleaseAsset[] => {
      const sha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
      if (!sha256 || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0) return [];
      return [{
        id: asset.id,
        name: asset.name,
        size: asset.size,
        sha256,
        downloadUrl: asset.browser_download_url,
      }];
    }) : [],
  }));
  return { refreshedAt, stale: false, releases };
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

export function recommendVariant(hasDisplay: boolean, flashSize: string, profile = "default"): string {
  if (profile !== "default") return profile;
  if (hasDisplay) return "display";
  if (flashSize === "2") return "2mb";
  if (flashSize === "16") return "16mb";
  return "default";
}

const GEOMETRY_VARIANTS = new Set(["2mb", "16mb", "display"]);

export function firmwareProfiles(assets: FirmwareAsset[]): string[] {
  return assets
    .map((asset) => asset.variant)
    .filter((variant, index, variants) => !GEOMETRY_VARIANTS.has(variant) && variants.indexOf(variant) === index);
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
