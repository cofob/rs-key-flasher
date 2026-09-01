"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Heading,
  Inline,
  Link,
  Select,
  Stack,
  Text,
  TextField,
} from "@cofob/design-system-react/static";
import { Search } from "lucide-react";
import type {
  PreviewBuild,
  PreviewBuildSummary,
  PreviewKind,
  PreviewListResponse,
} from "../../lib/previews";
import type { FirmwareAsset, PreviewFirmwareAsset } from "../../lib/releases";
import { FirmwareWorkbench } from "../firmware-workbench";

const API_BASE = import.meta.env.VITE_FLASHER_API_BASE || "";

interface Filters {
  q: string;
  kind: PreviewKind;
  pr: string;
  branch: string;
}

const EMPTY_FILTERS: Filters = { q: "", kind: "all", pr: "", branch: "" };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function queryFor(filters: Filters, cursor?: string): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.kind !== "all") query.set("kind", filters.kind);
  if (filters.pr) query.set("pr", filters.pr);
  if (filters.branch) query.set("branch", filters.branch);
  query.set("limit", "20");
  if (cursor) query.set("cursor", cursor);
  return query;
}

async function fetchList(filters: Filters, cursor?: string, commit?: string): Promise<PreviewListResponse> {
  const query = queryFor(filters, cursor);
  if (commit) query.set("commit", commit);
  const response = await fetch(`${API_BASE}/api/previews?${query}`);
  const body = await response.json() as PreviewListResponse | { error?: string };
  if (!response.ok || !("items" in body)) throw new Error("error" in body && body.error ? body.error : "Could not load preview builds.");
  return body;
}

async function fetchBuild(id: string): Promise<PreviewBuild> {
  const response = await fetch(`${API_BASE}/api/previews/${encodeURIComponent(id)}`);
  const body = await response.json() as PreviewBuild | { error?: string };
  if (!response.ok || !("assets" in body)) throw new Error("error" in body && body.error ? body.error : "Could not load the preview build.");
  return body;
}

function buildAssets(build: PreviewBuild | null): PreviewFirmwareAsset[] {
  if (!build) return [];
  return build.assets.map((asset) => ({
    source: "preview",
    id: asset.id,
    buildId: build.id,
    commitSha: build.commitSha,
    name: asset.filename,
    size: asset.size,
    sha256: asset.sha256,
    variant: asset.variant,
    version: build.commitSha.slice(0, 12),
    ...(build.storage.format === "tar.zst" ? { archive: build.storage } : {}),
  }));
}

interface PreviewCatalogProps {
  draft: Filters;
  items: PreviewBuildSummary[];
  nextCursor: string | null;
  selected: PreviewBuild | null;
  commitHistory: PreviewBuildSummary[];
  historyCursor: string | null;
  loading: boolean;
  error: string;
  onDraftChange(value: Filters): void;
  onSearch(event: FormEvent<HTMLFormElement>): void;
  onReset(): void;
  onSelect(item: PreviewBuildSummary): void;
  onCommit(commitSha: string): void;
  onLoadMore(): void;
  onLoadHistory(): void;
}

export function PreviewCatalog({
  draft,
  items,
  nextCursor,
  selected,
  commitHistory,
  historyCursor,
  loading,
  error,
  onDraftChange,
  onSearch,
  onReset,
  onSelect,
  onCommit,
  onLoadMore,
  onLoadHistory,
}: PreviewCatalogProps) {
  const selectedPr = selected?.pullRequests[0];
  return (
    <Stack gap="lg" className="preview-catalog">
      <form onSubmit={onSearch}>
        <Stack gap="md">
          <TextField
            label="Search previews"
            type="search"
            placeholder="PR title, branch, actor, or commit"
            value={draft.q}
            onChange={(event) => onDraftChange({ ...draft, q: event.target.value })}
          />
          <div className="preview-filter-grid">
            <Select
              label="Build type"
              value={draft.kind}
              onChange={(event) => onDraftChange({ ...draft, kind: event.target.value as PreviewKind })}
            >
              <option value="all">All</option>
              <option value="pr">Pull requests</option>
              <option value="main">main</option>
            </Select>
            <TextField
              label="PR number"
              inputMode="numeric"
              placeholder="16"
              value={draft.pr}
              onChange={(event) => onDraftChange({ ...draft, pr: event.target.value.replace(/\D/g, "") })}
            />
            <TextField
              label="Branch"
              placeholder="feature/example"
              value={draft.branch}
              onChange={(event) => onDraftChange({ ...draft, branch: event.target.value })}
            />
          </div>
          <Inline gap="sm" wrap>
            <Button type="submit" startIcon={Search} loading={loading}>Search</Button>
            <Button type="button" variant="secondary" onClick={onReset}>Reset</Button>
          </Inline>
        </Stack>
      </form>

      {error && <Alert tone="danger" title="Preview builds are unavailable">{error}</Alert>}
      {!error && !loading && !items.length && (
        <Alert tone="info" title="No preview builds found">Change the filters or wait for a successful firmware CI run.</Alert>
      )}

      <Stack gap="sm">
        <Heading level={3} size="md">Recent builds</Heading>
        <div className="preview-build-list">
          {items.map((item) => {
            const pullRequest = item.pullRequests[0];
            return (
              <article className="preview-build" data-selected={selected?.id === item.id} key={item.id}>
                <Stack gap="sm">
                  <Inline justify="between" align="start" gap="sm" wrap>
                    <Stack gap="sm">
                      <Text as="span">
                        {pullRequest ? (
                          <Link href={pullRequest.url} external>PR #{pullRequest.number}: {pullRequest.title}</Link>
                        ) : <strong>main build</strong>}
                      </Text>
                      <Text size="sm" tone="muted">
                        {item.branch} by {item.actor}
                      </Text>
                    </Stack>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onSelect(item)}>
                      {selected?.id === item.id ? "Selected" : "Use build"}
                    </Button>
                  </Inline>
                  <Inline gap="md" wrap>
                    <Link href={`https://github.com/${item.sourceRepository}/commit/${item.commitSha}`} external>
                      {item.commitSha.slice(0, 12)}
                    </Link>
                    <Text as="span" size="sm" tone="muted">{formatDate(item.publishedAt)}</Text>
                    <Link href={item.runUrl} external>CI run {item.runId} · attempt {item.runAttempt}</Link>
                  </Inline>
                </Stack>
              </article>
            );
          })}
        </div>
        {nextCursor && <Button type="button" variant="secondary" loading={loading} onClick={onLoadMore}>Load more builds</Button>}
      </Stack>

      {selected && (
        <Stack gap="sm" className="preview-history">
          <Heading level={3} size="md">Commit history</Heading>
          <Text size="sm" tone="muted">
            {selectedPr ? `Pull request #${selectedPr.number}` : `main · ${selected.branch}`}
          </Text>
          <Select label="Commit" value={selected.commitSha} onChange={(event) => onCommit(event.target.value)}>
            {commitHistory.map((item) => (
              <option key={item.id} value={item.commitSha}>
                {item.commitSha.slice(0, 12)} · {formatDate(item.publishedAt)}
              </option>
            ))}
          </Select>
          {historyCursor && (
            <Button type="button" variant="secondary" loading={loading} onClick={onLoadHistory}>
              Load older commits
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

export function PreviewFlasher() {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<PreviewBuildSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PreviewBuild | null>(null);
  const [commitHistory, setCommitHistory] = useState<PreviewBuildSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestEpoch = useRef(0);

  const replaceUrl = useCallback((nextFilters: Filters, commit?: string, selectedBuild?: PreviewBuildSummary) => {
    const query = new URLSearchParams();
    if (nextFilters.q) query.set("q", nextFilters.q);
    if (nextFilters.kind !== "all") query.set("kind", nextFilters.kind);
    const selectedPr = selectedBuild?.pullRequests[0]?.number;
    if (selectedPr) query.set("pr", String(selectedPr));
    else if (nextFilters.pr) query.set("pr", nextFilters.pr);
    if (nextFilters.branch) query.set("branch", nextFilters.branch);
    if (commit) query.set("commit", commit);
    window.history.replaceState(null, "", `/preview${query.size ? `?${query}` : ""}`);
  }, []);

  const loadHistory = useCallback(async (build: PreviewBuildSummary, cursor?: string) => {
    const pullRequest = build.pullRequests[0];
    const streamFilters: Filters = pullRequest
      ? { ...EMPTY_FILTERS, kind: "pr", pr: String(pullRequest.number) }
      : { ...EMPTY_FILTERS, kind: "main", branch: build.branch };
    const page = await fetchList(streamFilters, cursor);
    setCommitHistory((current) => {
      const combined = cursor ? [...current, ...page.items] : page.items;
      if (!combined.some((item) => item.id === build.id)) combined.unshift(build);
      return combined.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
    });
    setHistoryCursor(page.nextCursor);
  }, []);

  const selectBuild = useCallback(async (summary: PreviewBuildSummary, updateUrl = true) => {
    setLoading(true);
    setError("");
    try {
      const build = await fetchBuild(summary.id);
      setSelected(build);
      await loadHistory(build);
      if (updateUrl) replaceUrl(filters, build.commitSha, build);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the preview build.");
    } finally {
      setLoading(false);
    }
  }, [filters, loadHistory, replaceUrl]);

  const loadBuilds = useCallback(async (nextFilters: Filters, cursor?: string, initialCommit?: string) => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError("");
    try {
      const page = await fetchList(nextFilters, cursor, initialCommit);
      if (epoch !== requestEpoch.current) return;
      setItems((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      if (!cursor && page.items[0]) await selectBuild(page.items[0], false);
      if (!cursor && !page.items.length) {
        setSelected(null);
        setCommitHistory([]);
        setHistoryCursor(null);
      }
    } catch (reason) {
      if (epoch === requestEpoch.current) setError(reason instanceof Error ? reason.message : "Could not load preview builds.");
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [selectBuild]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const initial: Filters = {
      q: query.get("q") || "",
      kind: (["all", "pr", "main"].includes(query.get("kind") || "") ? query.get("kind") : "all") as PreviewKind,
      pr: /^\d+$/.test(query.get("pr") || "") ? query.get("pr") || "" : "",
      branch: query.get("branch") || "",
    };
    const commit = /^[0-9a-f]{4,40}$/i.test(query.get("commit") || "") ? query.get("commit") || undefined : undefined;
    Promise.resolve().then(() => {
      setDraft(initial);
      setFilters(initial);
      void loadBuilds(initial, undefined, commit);
    });
    // The initial URL is read once. Later URL changes are made by this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // The initial URL is read once. Later changes are made by this page.

  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = { ...draft, q: draft.q.trim(), branch: draft.branch.trim() };
    setDraft(normalized);
    setFilters(normalized);
    replaceUrl(normalized);
    void loadBuilds(normalized);
  }

  function reset(): void {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    replaceUrl(EMPTY_FILTERS);
    void loadBuilds(EMPTY_FILTERS);
  }

  function selectCommit(commitSha: string): void {
    const summary = commitHistory.find((item) => item.commitSha === commitSha);
    if (summary) void selectBuild(summary);
  }

  const assets = useMemo<FirmwareAsset[]>(() => buildAssets(selected), [selected]);

  return (
    <FirmwareWorkbench
      title="Development preview builds"
      description="Find a successful CI build, inspect its commit, and download, sign, or flash the selected firmware."
      remoteLabel="Preview build"
      remoteDescription="Choose a successful CI build"
      assets={assets}
      remoteTrusted={Boolean(selected && selected.assets.length === 20)}
      remoteSelection="asset-list"
      notices={(
        <Alert tone="warning" title="Preview firmware is experimental">
          Preview builds contain unmerged or recently changed code. They are not official releases and can be broken. Check the pull request and commit before you use them.
        </Alert>
      )}
      catalog={(
        <PreviewCatalog
          draft={draft}
          items={items}
          nextCursor={nextCursor}
          selected={selected}
          commitHistory={commitHistory}
          historyCursor={historyCursor}
          loading={loading}
          error={error}
          onDraftChange={setDraft}
          onSearch={search}
          onReset={reset}
          onSelect={(item) => void selectBuild(item)}
          onCommit={selectCommit}
          onLoadMore={() => { if (nextCursor) void loadBuilds(filters, nextCursor); }}
          onLoadHistory={() => { if (selected && historyCursor) void loadHistory(selected, historyCursor); }}
        />
      )}
      footerNavigation={<Link href="/">Official releases</Link>}
    />
  );
}
