"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Link, Select, Stack, Switch, Text } from "@cofob/design-system-react/static";
import { ShieldCheck } from "lucide-react";
import { fetchReleaseAttestations, RS_KEY_REPOSITORY_URL } from "../lib/release-attestation";
import {
  firmwareAssets,
  releaseManifestFromGitHub,
  resolveReleaseManifest,
  type Release,
  type ReleaseManifest,
} from "../lib/releases";
import { FirmwareWorkbench } from "./firmware-workbench";

type AttestationCheck = { status: "pending" | "verified" | "failed"; error?: string };

const API_SOURCE_KEY = "rs-key-flasher-api-source";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/TheMaxMur/RS-Key/releases?per_page=100";

interface ReleaseCatalogProps {
  releases: Release[];
  release?: Release;
  releaseTag: string;
  showPrereleases: boolean;
  attestation?: AttestationCheck;
  onReleaseChange(tag: string): void;
  onPrereleasesChange(value: boolean): void;
}

export function ReleaseCatalog({
  releases,
  release,
  releaseTag,
  showPrereleases,
  attestation,
  onReleaseChange,
  onPrereleasesChange,
}: ReleaseCatalogProps) {
  return (
    <Stack gap="md">
      <Select
        label="Release"
        value={release?.tag || releaseTag}
        disabled={!releases.length}
        onChange={(event) => onReleaseChange(event.target.value)}
      >
        {!releases.length && <option value="">Loading releases…</option>}
        {releases.map((item) => (
          <option key={item.tag} value={item.tag}>
            {item.tag}{item.prerelease ? " · prerelease" : ""}
          </option>
        ))}
      </Select>
      <Switch
        label="Show prereleases"
        checked={showPrereleases}
        onChange={(event) => onPrereleasesChange(event.target.checked)}
      />
      <Text size="sm" tone="muted">
        Source: <Link href={RS_KEY_REPOSITORY_URL} external>official RS-Key repository</Link>
      </Text>
      {attestation?.status === "pending" && (
        <Alert tone="warning" title="Verifying the GitHub release">
          This browser is checking the keyless release attestation.
        </Alert>
      )}
      {attestation?.status === "verified" && (
        <Alert tone="success" title="GitHub release verified" icon={ShieldCheck}>
          The keyless attestation, Git tag, and all release asset SHA-256 values are valid.
        </Alert>
      )}
      {attestation?.status === "failed" && (
        <Alert tone="danger" title="GitHub release attestation failed">
          {attestation.error || "This browser could not verify the release."}
        </Alert>
      )}
    </Stack>
  );
}

export function Flasher() {
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [showPrereleases, setShowPrereleases] = useState(false);
  const [directGitHub, setDirectGitHub] = useState(false);
  const [directFallback, setDirectFallback] = useState(false);
  const [attestationChecks, setAttestationChecks] = useState<Record<string, AttestationCheck>>({});

  useEffect(() => {
    const useDirectGitHub = localStorage.getItem(API_SOURCE_KEY) === "github";
    const directHeaders = { Accept: "application/vnd.github+json" };
    const fetchManifest = async (url: string, direct: boolean): Promise<ReleaseManifest> => {
      const response = await fetch(url, direct ? { headers: directHeaders } : undefined);
      const body = await response.json() as unknown;
      if (!response.ok) {
        const message = typeof body === "object" && body && "message" in body
          ? String(body.message)
          : typeof body === "object" && body && "error" in body ? String(body.error) : "Could not load releases.";
        throw new Error(message);
      }
      return direct ? releaseManifestFromGitHub(body) : body as ReleaseManifest;
    };
    const loadDirect = async (): Promise<ReleaseManifest> => {
      const data = await fetchManifest(GITHUB_RELEASES_URL, true);
      const attestations = await fetchReleaseAttestations(data.releases, directHeaders);
      return {
        ...data,
        releases: data.releases.map((release, index) => ({ ...release, attestation: attestations[index] })),
      };
    };
    resolveReleaseManifest(
      useDirectGitHub,
      () => fetchManifest(`${import.meta.env.VITE_FLASHER_API_BASE || ""}/api/releases`, false),
      loadDirect,
    )
      .then(({ manifest: data, directGitHub: resolvedDirectGitHub, directFallback: usedDirectFallback }) => {
        setAttestationChecks({});
        setDirectGitHub(resolvedDirectGitHub);
        setDirectFallback(usedDirectFallback);
        setManifest(data);
        const stable = data.releases.find((release) => !release.prerelease);
        setReleaseTag(stable?.tag || data.releases[0]?.tag || "");
      })
      .catch((reason) => setReleaseError(reason instanceof Error ? reason.message : "Could not load releases."));
  }, []);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    void (async () => {
      let verifyReleaseAttestationClient: typeof import("../lib/release-attestation-client").verifyReleaseAttestationClient;
      try {
        ({ verifyReleaseAttestationClient } = await import("../lib/release-attestation-client"));
      } catch (reason) {
        if (!cancelled) {
          const error = reason instanceof Error ? reason.message : "The browser verifier could not start.";
          setAttestationChecks(Object.fromEntries(
            manifest.releases.map((release) => [release.tag, { status: "failed", error } satisfies AttestationCheck]),
          ));
        }
        return;
      }
      const checks = await Promise.all(manifest.releases.map(async (release): Promise<[string, AttestationCheck]> => {
        try {
          if (!release.attestation) throw new Error("The release has no GitHub keyless attestation.");
          await verifyReleaseAttestationClient(release, release.attestation);
          return [release.tag, { status: "verified" }];
        } catch (reason) {
          return [release.tag, {
            status: "failed",
            error: reason instanceof Error ? reason.message : "The release attestation is invalid.",
          }];
        }
      }));
      if (!cancelled) setAttestationChecks(Object.fromEntries(checks));
    })();
    return () => { cancelled = true; };
  }, [manifest]);

  const visibleReleases = useMemo(
    () => manifest?.releases.filter((release) => showPrereleases || !release.prerelease) || [],
    [manifest, showPrereleases],
  );
  const release = visibleReleases.find((candidate) => candidate.tag === releaseTag) || visibleReleases[0];
  const assets = useMemo(() => release ? firmwareAssets(release) : [], [release]);
  const releaseAttestation = release
    ? attestationChecks[release.tag] || { status: "pending" as const }
    : undefined;
  const verifiedOfficialReleases = manifest?.releases.filter((item) =>
    attestationChecks[item.tag]?.status === "verified",
  ) || [];
  const officialComparisonReady = Boolean(manifest?.releases.length && manifest.releases.every((item) =>
    attestationChecks[item.tag]?.status === "verified",
  ));
  const officialComparisonFailed = Boolean(manifest?.releases.some((item) =>
    attestationChecks[item.tag]?.status === "failed",
  ));

  function changeApiSource(useDirectGitHub: boolean): void {
    localStorage.setItem(API_SOURCE_KEY, useDirectGitHub ? "github" : "proxy");
    location.reload();
  }

  return (
    <FirmwareWorkbench
      title="Flash your RS-Key"
      description="Pick the right firmware, connect an RP2350 device in BOOTSEL mode, and install it with read-back verification."
      remoteLabel="GitHub release"
      remoteDescription="Choose a published build"
      assets={assets}
      remoteTrusted={releaseAttestation?.status === "verified"}
      directGitHub={directGitHub}
      officialReleases={verifiedOfficialReleases}
      officialComparisonReady={officialComparisonReady}
      officialComparisonFailed={officialComparisonFailed}
      notices={<>
        {releaseError && <Alert tone="danger" title="Releases are unavailable">{releaseError}</Alert>}
        {directFallback && (
          <Alert tone="warning" title="Using the Direct GitHub API">
            The flasher API returned cached release data. Current release data was loaded directly from GitHub.
          </Alert>
        )}
        {manifest?.stale && (
          <Alert tone="warning" title="Using cached release data">
            GitHub is unavailable. Cached firmware remains available when it is already mirrored.
          </Alert>
        )}
      </>}
      catalog={(
        <ReleaseCatalog
          releases={visibleReleases}
          release={release}
          releaseTag={releaseTag}
          showPrereleases={showPrereleases}
          attestation={releaseAttestation}
          onReleaseChange={setReleaseTag}
          onPrereleasesChange={setShowPrereleases}
        />
      )}
      footerNavigation={<Link href="/preview">Development previews</Link>}
      footerControls={(
        <Switch
          className="api-source-switch"
          label="Direct GitHub API"
          checked={directGitHub}
          onChange={(event) => changeApiSource(event.target.checked)}
        />
      )}
    />
  );
}
