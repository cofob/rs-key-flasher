import { describe, expect, it, vi } from "vitest";
import { resolveReleaseManifest, type ReleaseManifest } from "../lib/releases";

function manifest(stale: boolean): ReleaseManifest {
  return { refreshedAt: "2026-08-29T00:00:00.000Z", stale, releases: [] };
}

describe("release manifest source fallback", () => {
  it("uses the direct GitHub API when the flasher API returns cached data", async () => {
    const cached = manifest(true);
    const direct = manifest(false);
    const loadDirect = vi.fn(async () => direct);

    await expect(resolveReleaseManifest(false, async () => cached, loadDirect)).resolves.toEqual({
      manifest: direct,
      directGitHub: true,
      directFallback: true,
    });
    expect(loadDirect).toHaveBeenCalledOnce();
  });

  it("keeps cached data when the direct GitHub API is unavailable", async () => {
    const cached = manifest(true);

    await expect(resolveReleaseManifest(
      false,
      async () => cached,
      async () => { throw new Error("GitHub is unavailable"); },
    )).resolves.toEqual({
      manifest: cached,
      directGitHub: false,
      directFallback: false,
    });
  });

  it("does not contact GitHub when the flasher API data is current", async () => {
    const current = manifest(false);
    const loadDirect = vi.fn(async () => manifest(false));

    await expect(resolveReleaseManifest(false, async () => current, loadDirect)).resolves.toEqual({
      manifest: current,
      directGitHub: false,
      directFallback: false,
    });
    expect(loadDirect).not.toHaveBeenCalled();
  });
});
