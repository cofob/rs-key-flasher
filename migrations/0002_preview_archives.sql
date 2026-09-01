PRAGMA foreign_keys = ON;

CREATE TABLE preview_archives (
  build_id TEXT PRIMARY KEY REFERENCES preview_builds(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  uncompressed_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  archived_at INTEGER NOT NULL,
  legacy_delete_after INTEGER NOT NULL,
  legacy_deleted_at INTEGER
);

CREATE INDEX preview_archives_cleanup_idx
  ON preview_archives(legacy_deleted_at, legacy_delete_after);

CREATE TABLE preview_assets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL REFERENCES preview_builds(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT UNIQUE,
  UNIQUE (build_id, variant)
);

INSERT INTO preview_assets_new (id, build_id, variant, filename, size, sha256, r2_key)
SELECT id, build_id, variant, filename, size, sha256, r2_key FROM preview_assets;

DROP TABLE preview_assets;
ALTER TABLE preview_assets_new RENAME TO preview_assets;

CREATE INDEX preview_assets_build_idx ON preview_assets(build_id);
