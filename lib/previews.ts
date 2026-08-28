export const PREVIEW_VARIANTS = [
  "default",
  "pqc",
  "fips",
  "fips-pqc",
  "strong-pin",
  "strong-pin-pqc",
  "always-uv",
  "always-uv-pqc",
  "strict-up",
  "strict-up-pqc",
  "display",
  "2mb",
  "16mb",
  "board-waveshare-one",
  "board-tenstar-usb",
  "board-seeed-xiao",
  "board-waveshare-touch-lcd",
  "board-abrobot-4m",
  "board-abrobot-16m",
  "strict-config",
] as const;

export type PreviewVariant = typeof PREVIEW_VARIANTS[number];
export type PreviewKind = "all" | "pr" | "main";

export interface PreviewPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
}

export interface PreviewAssetMetadata {
  variant: PreviewVariant;
  filename: string;
  size: number;
  sha256: string;
}

export interface PreviewUploadMetadata {
  schemaVersion: 1;
  repository: string;
  repositoryId: number;
  event: "pull_request" | "push";
  runId: number;
  runAttempt: number;
  runUrl: string;
  commitSha: string;
  branch: string;
  actor: string;
  sourceRepository: string;
  createdAt: string;
  pullRequests: PreviewPullRequest[];
  assets: PreviewAssetMetadata[];
}

export interface PreviewAsset extends PreviewAssetMetadata {
  id: number;
  buildId: string;
}

export interface PreviewBuildSummary {
  id: string;
  runId: number;
  runAttempt: number;
  event: "pull_request" | "push";
  commitSha: string;
  branch: string;
  actor: string;
  runUrl: string;
  repository: string;
  sourceRepository: string;
  createdAt: string;
  publishedAt: string;
  expiresAt: string;
  pullRequests: PreviewPullRequest[];
  assetCount: number;
}

export interface PreviewBuild extends PreviewBuildSummary {
  assets: PreviewAsset[];
}

export interface PreviewListResponse {
  items: PreviewBuildSummary[];
  nextCursor: string | null;
}

export function previewAssetFilename(variant: string): string {
  return `firmware-${variant}.uf2`;
}
