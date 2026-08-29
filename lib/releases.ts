import type { ReleaseAttestation } from "./release-attestation";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  sha256: string;
  downloadUrl?: string;
}

export interface Release {
  id: number;
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  immutable: boolean;
  assets: ReleaseAsset[];
  attestation?: ReleaseAttestation;
}

export interface ReleaseManifest {
  refreshedAt: string;
  stale: boolean;
  releases: Release[];
}

export interface ReleaseManifestLoadResult {
  manifest: ReleaseManifest;
  directGitHub: boolean;
  directFallback: boolean;
}

export async function resolveReleaseManifest(
  useDirectGitHub: boolean,
  loadProxy: () => Promise<ReleaseManifest>,
  loadDirect: () => Promise<ReleaseManifest>,
): Promise<ReleaseManifestLoadResult> {
  if (useDirectGitHub) {
    return { manifest: await loadDirect(), directGitHub: true, directFallback: false };
  }

  const cachedManifest = await loadProxy();
  if (!cachedManifest.stale) {
    return { manifest: cachedManifest, directGitHub: false, directFallback: false };
  }

  try {
    return { manifest: await loadDirect(), directGitHub: true, directFallback: true };
  } catch {
    return { manifest: cachedManifest, directGitHub: false, directFallback: false };
  }
}

interface FirmwareAssetBase extends ReleaseAsset {
  variant: string;
  version: string;
}

export interface ReleaseFirmwareAsset extends FirmwareAssetBase {
  source: "release";
  tag: string;
}

export interface PreviewFirmwareAsset extends FirmwareAssetBase {
  source: "preview";
  buildId: string;
  commitSha: string;
}

export interface LocalFirmwareAsset extends FirmwareAssetBase {
  source: "local";
}

export type FirmwareAsset = ReleaseFirmwareAsset | PreviewFirmwareAsset | LocalFirmwareAsset;

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  browser_download_url: string;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  immutable: boolean;
  assets: GitHubAsset[];
}

export function releaseManifestFromGitHub(raw: unknown, refreshedAt = new Date().toISOString()): ReleaseManifest {
  if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid release list.");
  const releases = (raw as GitHubRelease[]).filter((release) =>
    !release.draft && Number.isSafeInteger(release.id),
  ).map((release): Release => ({
    id: release.id,
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at || "",
    prerelease: release.prerelease,
    immutable: release.immutable === true,
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

export function parseFirmwareAsset(asset: ReleaseAsset, tag: string): ReleaseFirmwareAsset | null {
  const prefix = `rs-key-${tag}-`;
  const suffix = ".uf2";
  if (!asset.name.startsWith(prefix) || !asset.name.endsWith(suffix)) return null;

  const variant = asset.name.slice(prefix.length, -suffix.length);
  if (!variant) return null;

  return {
    ...asset,
    source: "release",
    tag,
    version: tag.startsWith("v") ? tag.slice(1) : tag,
    variant,
  };
}

export function firmwareAssets(release: Release): FirmwareAsset[] {
  return release.assets
    .map((asset) => parseFirmwareAsset(asset, release.tag))
    .filter((asset): asset is ReleaseFirmwareAsset => asset !== null)
    .sort((a, b) => a.variant.localeCompare(b.variant));
}

export function findOfficialAssetBySha256(releases: Release[], sha256: string): { tag: string; asset: ReleaseAsset } | undefined {
  for (const release of releases) {
    const asset = release.assets.find((candidate) => candidate.sha256 === sha256);
    if (asset) return { tag: release.tag, asset };
  }
  return undefined;
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
  "board-waveshare-one": "Waveshare RP2350-One",
  "board-tenstar-usb": "Tenstar RP2350 USB",
  "board-seeed-xiao": "Seeed XIAO RP2350",
  "board-waveshare-touch-lcd": "Waveshare touch display",
  "board-abrobot-4m": "Abrobot RP2350 · 4 MB",
  "board-abrobot-16m": "Abrobot RP2350 · 16 MB",
};

export function variantLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant;
}
