import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("preview archive migration", () => {
  it("keeps asset IDs and permits removal of legacy storage keys", async () => {
    const database = new DatabaseSync(":memory:");
    const initial = await readFile(new URL("../migrations/0001_preview_builds.sql", import.meta.url), "utf8");
    const archive = await readFile(new URL("../migrations/0002_preview_archives.sql", import.meta.url), "utf8");
    database.exec(initial);
    database.exec(`
      INSERT INTO preview_builds
        (id, run_id, run_attempt, event, status, commit_sha, branch, actor, run_url, repository,
         source_repository, metadata_json, created_at, published_at, expires_at)
      VALUES ('123:2', 123, 2, 'push', 'ready', '${"a".repeat(40)}', 'main', 'ci',
        'https://example.test/run', 'TheMaxMur/RS-Key', 'TheMaxMur/RS-Key', '{}', 1, 2, 9999999999);
      INSERT INTO preview_assets (id, build_id, variant, filename, size, sha256, r2_key)
      VALUES (77, '123:2', 'default', 'firmware-default.uf2', 512, '${"b".repeat(64)}', 'previews/123/2/default.uf2');
    `);

    database.exec(archive);
    database.exec("UPDATE preview_assets SET r2_key = NULL WHERE id = 77");

    expect(database.prepare("SELECT id, r2_key FROM preview_assets").get()).toEqual({ id: 77, r2_key: null });
    const archiveColumns = database.prepare("PRAGMA table_info(preview_archives)").all()
      .map((column) => (column as { name: string }).name);
    expect(archiveColumns).toContain("legacy_delete_after");
    expect(archiveColumns).toContain("legacy_deleted_at");
    database.close();
  });
});
