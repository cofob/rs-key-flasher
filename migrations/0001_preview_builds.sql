PRAGMA foreign_keys = ON;

CREATE TABLE preview_builds (
  id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('pull_request', 'push')),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'failed')),
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  actor TEXT NOT NULL,
  run_url TEXT NOT NULL,
  repository TEXT NOT NULL,
  source_repository TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  expires_at INTEGER NOT NULL,
  error TEXT,
  UNIQUE (run_id, run_attempt)
);

CREATE TABLE preview_build_prs (
  build_id TEXT NOT NULL REFERENCES preview_builds(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  PRIMARY KEY (build_id, pr_number)
);

CREATE TABLE preview_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL REFERENCES preview_builds(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  UNIQUE (build_id, variant)
);

CREATE INDEX preview_builds_public_idx
  ON preview_builds(status, expires_at, published_at DESC, id DESC);
CREATE INDEX preview_builds_commit_idx ON preview_builds(commit_sha);
CREATE INDEX preview_builds_branch_idx ON preview_builds(branch);
CREATE INDEX preview_build_prs_number_idx ON preview_build_prs(pr_number, build_id);
CREATE INDEX preview_assets_build_idx ON preview_assets(build_id);
