import type { FirmwareAsset } from "./releases";

export function assetUrl(asset: FirmwareAsset, directGitHub = false): string {
  const base = import.meta.env.VITE_FLASHER_API_BASE || "";
  if (asset.source === "preview") return `${base}/api/preview-assets/${asset.id}`;
  if (asset.source === "local") throw new Error("A local firmware file has no download URL.");
  if (directGitHub) {
    return asset.downloadUrl
      || `https://github.com/TheMaxMur/RS-Key/releases/download/${encodeURIComponent(asset.tag)}/${encodeURIComponent(asset.name)}`;
  }
  const query = new URLSearchParams({
    tag: asset.tag,
    name: asset.name,
    sha256: asset.sha256,
    size: String(asset.size),
  });
  return `${base}/api/assets/${asset.id}?${query}`;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = bytes.slice();
  return hex(await crypto.subtle.digest("SHA-256", owned.buffer));
}

export async function downloadAsset(
  asset: FirmwareAsset,
  onProgress: (value: number) => void = () => {},
  directGitHub = false,
): Promise<Uint8Array> {
  const response = await fetch(assetUrl(asset, directGitHub));
  if (!response.ok || !response.body) {
    const message = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(message?.error || `Firmware download failed with ${response.status}.`);
  }

  const output = new Uint8Array(asset.size);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > output.byteLength) throw new Error("Firmware is larger than release metadata.");
    output.set(value, offset);
    offset += value.byteLength;
    onProgress(offset / asset.size);
  }
  if (offset !== asset.size) throw new Error("Firmware size does not match release metadata.");
  return output;
}

export async function downloadVerifiedAsset(
  asset: FirmwareAsset,
  onProgress?: (value: number) => void,
  directGitHub = false,
): Promise<Uint8Array> {
  const bytes = await downloadAsset(asset, onProgress, directGitHub);
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error("Firmware SHA-256 does not match its metadata.");
  return bytes;
}
