import { Container } from "@cloudflare/containers";
import { PREVIEW_VARIANTS, previewAssetFilename } from "../lib/previews";

const LEGACY_GRACE_SECONDS = 24 * 60 * 60;

interface PreviewArchiverEnv {
  PREVIEWS: D1Database;
  RELEASE_ASSETS: R2Bucket;
}

interface BuildRow {
  id: string;
  run_id: number;
  run_attempt: number;
  status: string;
  expires_at: number;
}

interface AssetRow {
  filename: string;
  size: number;
  sha256: string;
  r2_key: string | null;
}

interface ArchiveRow {
  r2_key: string;
}

async function processText(process: ExecProcess): Promise<string> {
  const output = await process.output();
  if (output.exitCode !== 0) {
    const error = new TextDecoder().decode(output.stderr).trim();
    throw new Error(error || `Container command failed with ${output.exitCode}.`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function safeBuildId(value: string): boolean {
  return /^[0-9]+:[0-9]+$/.test(value);
}

export class PreviewArchiver extends Container<PreviewArchiverEnv> {
  sleepAfter = "30s";
  enableInternet = false;
  entrypoint = ["sleep", "infinity"];

  async archive(buildId: string): Promise<"created" | "exists" | "skipped"> {
    if (!safeBuildId(buildId)) throw new Error("Invalid preview build ID.");

    const now = Math.floor(Date.now() / 1000);
    const [build, existing] = await Promise.all([
      this.env.PREVIEWS.prepare(
        "SELECT id, run_id, run_attempt, status, expires_at FROM preview_builds WHERE id = ?",
      ).bind(buildId).first<BuildRow>(),
      this.env.PREVIEWS.prepare(
        "SELECT r2_key FROM preview_archives WHERE build_id = ?",
      ).bind(buildId).first<ArchiveRow>(),
    ]);
    if (existing) return "exists";
    if (!build || build.status !== "ready" || build.expires_at <= now) return "skipped";

    const rows = await this.env.PREVIEWS.prepare(
      "SELECT filename, size, sha256, r2_key FROM preview_assets WHERE build_id = ? ORDER BY filename",
    ).bind(buildId).all<AssetRow>();
    const assets = rows.results;
    const expectedNames = new Set(PREVIEW_VARIANTS.map(previewAssetFilename));
    if (assets.length !== PREVIEW_VARIANTS.length ||
        assets.some((asset) => !expectedNames.has(asset.filename) || !asset.r2_key)) {
      throw new Error("The preview build does not have 20 individual assets.");
    }

    await this.start({ enableInternet: false, entrypoint: this.entrypoint });
    const container = this.ctx.container;
    if (!container) throw new Error("The archive container is not available.");

    const jobDirectory = `/tmp/preview-${build.run_id}-${build.run_attempt}-${crypto.randomUUID()}`;
    const archivePath = `${jobDirectory}/archive.tar.zst`;
    await processText(await container.exec(["mkdir", "-p", jobDirectory]));

    try {
      for (const asset of assets) {
        this.renewActivityTimeout();
        const object = await this.env.RELEASE_ASSETS.get(asset.r2_key!);
        if (!object?.body || object.size !== asset.size) {
          throw new Error(`${asset.filename} is missing or has the wrong size.`);
        }
        const write = await container.exec(["tee", asset.filename], {
          cwd: jobDirectory,
          stdin: object.body,
          stdout: "ignore",
          stderr: "pipe",
        });
        const exitCode = await write.exitCode;
        if (exitCode !== 0) throw new Error(`Could not write ${asset.filename}.`);

        const sha256 = (await processText(await container.exec(["sha256sum", asset.filename], {
          cwd: jobDirectory,
        }))).split(/\s+/)[0];
        if (sha256 !== asset.sha256) throw new Error(`${asset.filename} has the wrong SHA-256.`);
      }

      const filenames = assets.map((asset) => asset.filename);
      this.renewActivityTimeout();
      const command = [
        "tar --sort=name --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner -cf -",
        ...filenames,
        "| zstd -T0 -15 -o archive.tar.zst",
      ].join(" ");
      await processText(await container.exec(["sh", "-c", command], {
        cwd: jobDirectory,
        env: { LC_ALL: "C" },
      }));

      const archiveSha256 = (await processText(await container.exec(["sha256sum", archivePath])))
        .split(/\s+/)[0];
      const archiveSize = Number(await processText(await container.exec(["stat", "-c", "%s", archivePath])));
      if (!/^[0-9a-f]{64}$/.test(archiveSha256) || !Number.isSafeInteger(archiveSize) || archiveSize <= 0) {
        throw new Error("The archive metadata is invalid.");
      }

      const filename = `preview-${build.run_id}-${build.run_attempt}.tar.zst`;
      const r2Key = `previews/${build.run_id}/${build.run_attempt}/${archiveSha256}-previews.tar.zst`;
      const stream = await container.exec(["cat", archivePath], { stdout: "pipe", stderr: "pipe" });
      this.renewActivityTimeout();
      if (!stream.stdout) throw new Error("The archive stream is not available.");
      await this.env.RELEASE_ASSETS.put(r2Key, stream.stdout, {
        sha256: Uint8Array.from(
          archiveSha256.match(/../g) || [],
          (value) => Number.parseInt(value, 16),
        ).buffer,
        httpMetadata: {
          contentType: "application/zstd",
          contentDisposition: `attachment; filename="${filename}"`,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: {
          buildId,
          filename,
          sha256: archiveSha256,
          format: "tar.zst",
        },
      });
      if (await stream.exitCode !== 0) {
        await this.env.RELEASE_ASSETS.delete(r2Key);
        throw new Error("Could not read the completed archive.");
      }

      try {
        await this.env.PREVIEWS.prepare(`
          INSERT INTO preview_archives
            (build_id, filename, size, uncompressed_size, sha256, r2_key, archived_at, legacy_delete_after)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (build_id) DO NOTHING
        `).bind(
          buildId,
          filename,
          archiveSize,
          assets.reduce((sum, asset) => sum + asset.size, 0),
          archiveSha256,
          r2Key,
          now,
          now + LEGACY_GRACE_SECONDS,
        ).run();
      } catch (error) {
        await this.env.RELEASE_ASSETS.delete(r2Key);
        throw error;
      }
      return "created";
    } finally {
      await processText(await container.exec(["rm", "-rf", jobDirectory])).catch(() => undefined);
    }
  }
}
