"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createThemeController,
  type ThemeController,
  type ThemePreference,
  type ThemeState,
} from "@cofob/design-system-css";
import {
  Alert,
  AppShell,
  Button,
  Card,
  Container,
  Heading,
  Inline,
  Link,
  Progress,
  Radio,
  RadioGroup,
  Select,
  SkipLink,
  Stack,
  Switch,
  Text,
  TextField,
} from "@cofob/design-system-react/static";
import { CheckCircle2, Cpu, Download as DownloadIcon, ShieldCheck, Usb } from "lucide-react";
import { downloadVerifiedAsset, sha256Hex } from "../lib/assets";
import { flashUf2, hasWebUsb, requestPicobootDevice, type FlashStage } from "../lib/picoboot";
import { readSecureBootOtpState } from "../lib/otp";
import {
  fetchReleaseAttestation,
  RS_KEY_RELEASES_URL,
  RS_KEY_REPOSITORY_URL,
} from "../lib/release-attestation";
import {
  firmwareAssets,
  firmwareProfiles,
  findOfficialAssetBySha256,
  recommendVariant,
  releaseManifestFromGitHub,
  variantLabel,
  type FirmwareAsset,
  type ReleaseManifest,
} from "../lib/releases";
import { parseUf2 } from "../lib/uf2";
import { SecurityTools } from "./security-tools";

type SelectionMode = "easy" | "manual";
type FirmwareSource = "releases" | "local";
type AttestationCheck = { status: "pending" | "verified" | "failed"; error?: string };

const API_SOURCE_KEY = "rs-key-flasher-api-source";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/TheMaxMur/RS-Key/releases?per_page=100";
const MAX_LOCAL_UF2_SIZE = 32 * 1024 * 1024;

function downloadBytes(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function flashPercent(stage: FlashStage, completed: number, total: number): number {
  const ratio = total ? completed / total : 0;
  if (stage === "connect") return 30 + ratio * 5;
  if (stage === "erase") return 35 + ratio * 15;
  if (stage === "write") return 50 + ratio * 25;
  if (stage === "verify") return 75 + ratio * 20;
  return 95 + ratio * 5;
}

const STAGE_LABELS: Record<FlashStage, string> = {
  connect: "Connecting to picoboot…",
  erase: "Erasing firmware sectors…",
  write: "Writing firmware…",
  verify: "Reading back and verifying…",
  reboot: "Rebooting RS-Key…",
};

const THEMES: ThemePreference[] = ["system", "light", "dark"];
const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeState>({ preference: "system", resolvedTheme: "light" });
  const controllerRef = useRef<ThemeController | null>(null);

  useEffect(() => {
    const controller = createThemeController();
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setTheme);
    return () => {
      unsubscribe();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  const next = THEMES[(THEMES.indexOf(theme.preference) + 1) % THEMES.length];
  return (
    <button
      type="button"
      className="cf-theme-toggle theme-switcher"
      data-preference={theme.preference}
      data-theme={theme.resolvedTheme}
      aria-label={`${THEME_LABELS[theme.preference]}. Switch to ${THEME_LABELS[next]}.`}
      onClick={() => controllerRef.current?.setPreference(next)}
    >
      <span className="cf-theme-toggle__icon" aria-hidden data-cf-theme-icon />
      <span
        className="cf-theme-toggle__label"
        aria-hidden
        data-cf-theme-label
        data-label-system={THEME_LABELS.system}
        data-label-light={THEME_LABELS.light}
        data-label-dark={THEME_LABELS.dark}
      />
    </button>
  );
}

export function Flasher() {
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [showPrereleases, setShowPrereleases] = useState(false);
  const [firmwareSource, setFirmwareSource] = useState<FirmwareSource>("releases");
  const [localAsset, setLocalAsset] = useState<FirmwareAsset | null>(null);
  const [localBytes, setLocalBytes] = useState<Uint8Array | null>(null);
  const [localError, setLocalError] = useState("");
  const [directGitHub, setDirectGitHub] = useState(false);
  const [attestationChecks, setAttestationChecks] = useState<Record<string, AttestationCheck>>({});
  const [mode, setMode] = useState<SelectionMode>("easy");
  const [display, setDisplay] = useState(false);
  const [flashSize, setFlashSize] = useState("4");
  const [profile, setProfile] = useState("default");
  const [manualVariant, setManualVariant] = useState("default");
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [webUsb, setWebUsb] = useState(true);
  const [rawFlashEpoch, setRawFlashEpoch] = useState(0);
  const [securityBusy, setSecurityBusy] = useState(false);
  const operationLock = useRef(false);
  const flashLogRef = useRef("");
  const operationBusy = busy || downloadBusy || securityBusy;

  useEffect(() => {
    if (!busy) return;
    const percent = Math.round(progress);
    const signature = `${status}:${percent}`;
    if (flashLogRef.current === signature) return;
    flashLogRef.current = signature;
    console.info(`[RS-Key][flasher] ${status}`, { progress: percent });
  }, [busy, progress, status]);

  useEffect(() => {
    if (error) console.error("[RS-Key][flasher] Flash failed", { error });
  }, [error]);

  useEffect(() => {
    if (success) console.info("[RS-Key][flasher] Flash completed", { message: success });
  }, [success]);

  useEffect(() => {
    const useDirectGitHub = localStorage.getItem(API_SOURCE_KEY) === "github";
    Promise.resolve().then(() => {
      setWebUsb(hasWebUsb());
      setDirectGitHub(useDirectGitHub);
    });
    const releasesUrl = useDirectGitHub
      ? GITHUB_RELEASES_URL
      : `${import.meta.env.VITE_FLASHER_API_BASE || ""}/api/releases`;
    const directHeaders = { Accept: "application/vnd.github+json" };
    fetch(releasesUrl, useDirectGitHub ? { headers: directHeaders } : undefined)
      .then(async (response) => {
        const body = await response.json() as unknown;
        if (!response.ok) {
          const message = typeof body === "object" && body && "message" in body
            ? String(body.message)
            : typeof body === "object" && body && "error" in body ? String(body.error) : "Could not load releases.";
          throw new Error(message);
        }
        return useDirectGitHub ? releaseManifestFromGitHub(body) : body as ReleaseManifest;
      })
      .then(async (data) => {
        if (!useDirectGitHub) return data;
        const releases = await Promise.all(data.releases.map(async (release) => {
          try {
            return { ...release, attestation: await fetchReleaseAttestation(release, directHeaders) };
          } catch (reason) {
            console.error("[RS-Key][attestation] Could not load direct GitHub attestation", {
              tag: release.tag,
              error: reason instanceof Error ? reason.message : String(reason),
            });
            return release;
          }
        }));
        return { ...data, releases };
      })
      .then((data) => {
        setAttestationChecks({});
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
  const profiles = useMemo(() => firmwareProfiles(assets), [assets]);
  const effectiveProfile = profiles.includes(profile) ? profile : "default";
  const easyVariant = recommendVariant(display, flashSize, effectiveProfile);
  const effectiveManualVariant = assets.some((asset) => asset.variant === manualVariant)
    ? manualVariant
    : assets.find((asset) => asset.variant === "default")?.variant || assets[0]?.variant || "";
  const variant = mode === "easy" ? easyVariant : effectiveManualVariant;
  const releaseAsset = assets.find((asset) => asset.variant === variant);
  const selectedAsset = firmwareSource === "local" ? localAsset || undefined : releaseAsset;
  const releaseAttestation = release
    ? attestationChecks[release.tag] || { status: "pending" as const }
    : undefined;
  const releaseTrusted = releaseAttestation?.status === "verified";
  const verifiedOfficialReleases = manifest?.releases.filter((item) =>
    attestationChecks[item.tag]?.status === "verified",
  ) || [];
  const officialComparisonReady = Boolean(manifest && manifest.releases.length && manifest.releases.every((item) =>
    attestationChecks[item.tag]?.status === "verified",
  ));
  const officialComparisonFailed = Boolean(manifest && manifest.releases.some((item) =>
    attestationChecks[item.tag]?.status === "failed",
  ));
  const localOfficialMatch = localAsset && officialComparisonReady
    ? findOfficialAssetBySha256(verifiedOfficialReleases, localAsset.sha256)
    : undefined;

  async function chooseLocalUf2(file?: File): Promise<void> {
    setLocalAsset(null);
    setLocalBytes(null);
    setLocalError("");
    if (!file) return;
    try {
      if (!/\.uf2$/i.test(file.name)) throw new Error("Select a file with the .uf2 extension.");
      if (!file.size) throw new Error("The selected UF2 file is empty.");
      if (file.size > MAX_LOCAL_UF2_SIZE) throw new Error("The selected UF2 file is larger than 32 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      parseUf2(bytes);
      const sha256 = await sha256Hex(bytes);
      setLocalBytes(bytes);
      setLocalAsset({
        id: 0,
        name: file.name,
        size: bytes.length,
        sha256,
        tag: "local",
        version: "local",
        variant: "custom",
      });
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "Could not read the local UF2 file.");
    }
  }

  function changeApiSource(useDirectGitHub: boolean): void {
    localStorage.setItem(API_SOURCE_KEY, useDirectGitHub ? "github" : "proxy");
    location.reload();
  }

  async function startDownload(): Promise<void> {
    if (!releaseAsset || firmwareSource !== "releases" || operationLock.current) return;
    if (!releaseTrusted) {
      setError("The GitHub release attestation has not been verified in this browser.");
      return;
    }
    operationLock.current = true;
    setRawFlashEpoch((value) => value + 1);
    setDownloadBusy(true);
    setError("");
    setSuccess("");
    setProgress(1);
    setStatus("Downloading and checking the official UF2…");
    try {
      const bytes = await downloadVerifiedAsset(
        releaseAsset,
        (value) => setProgress(1 + value * 99),
        directGitHub,
      );
      downloadBytes(releaseAsset.name, bytes);
      setProgress(100);
      setStatus("Attestation and SHA-256 verified");
      setSuccess(`${releaseAsset.name} was verified and downloaded.`);
    } catch (reason) {
      setStatus("Stopped");
      setError(reason instanceof Error ? reason.message : "Firmware download failed.");
    } finally {
      setDownloadBusy(false);
      operationLock.current = false;
    }
  }

  async function startFlash() {
    if (!selectedAsset || operationLock.current) return;
    if (firmwareSource === "releases" && !releaseTrusted) {
      setError("The GitHub release attestation has not been verified in this browser.");
      return;
    }

    flashLogRef.current = "";
    console.info("[RS-Key][flasher] Flash started", {
      firmware: selectedAsset.name,
      source: firmwareSource,
    });
    operationLock.current = true;
    setRawFlashEpoch((value) => value + 1);
    setBusy(true);
    setError("");
    setSuccess("");
    setProgress(1);
    setStatus("Choose the BOOTSEL device…");

    try {
      const device = await requestPicobootDevice();
      setStatus("Checking device security state…");
      const security = await readSecureBootOtpState(device);
      if (security.secureBootEnabled) {
        throw new Error("Secure boot is enabled on this device. Use Security tools and the matching signing key.");
      }
      setStatus(firmwareSource === "local" ? "Reading local firmware…" : "Downloading firmware…");
      const bytes = firmwareSource === "local"
        ? localBytes?.slice()
        : await downloadVerifiedAsset(selectedAsset, (value) => setProgress(5 + value * 20), directGitHub);
      if (!bytes) throw new Error("Select a local UF2 file.");

      setStatus("Checking firmware SHA-256…");
      setProgress(27);

      const image = parseUf2(bytes);
      setProgress(30);
      await flashUf2(device, image, (stage, completed, total) => {
        setStatus(STAGE_LABELS[stage]);
        setProgress(flashPercent(stage, completed, total));
      });

      setStatus("Verified and complete");
      setProgress(100);
      setSuccess(`${selectedAsset.name} was written, read back, verified, and started.`);
    } catch (reason) {
      const message = reason instanceof DOMException && reason.name === "NotFoundError"
        ? "No BOOTSEL device was selected."
        : reason instanceof Error ? reason.message : "Flashing failed.";
      setStatus("Stopped");
      setError(message);
    } finally {
      setBusy(false);
      operationLock.current = false;
    }
  }

  return (
    <AppShell>
      <SkipLink targetId="main">Skip to flasher</SkipLink>
      <header className="site-header">
        <Container size="md">
          <Inline justify="between" align="center">
            <Inline gap="sm" align="center">
              <Cpu aria-hidden size={20} />
              <Text as="span" className="wordmark">RS-Key Flasher</Text>
            </Inline>
            <Inline gap="sm" align="center" wrap={false}>
              <Text as="span" size="sm" tone="muted" className="header-protocol">RP2350 picoboot</Text>
              <ThemeSwitcher />
            </Inline>
          </Inline>
        </Container>
      </header>

      <main id="main">
        <Container size="md" className="main-container">
          <Stack gap="lg">
            <div className="small-device-notice">
              <Alert tone="warning" title="Use a desktop computer to flash RS-Key">
                Flashing an RP2350 device does not work from a phone or tablet. You can still download firmware and create a signed UF2 here. Open this page on a desktop computer when you are ready to connect and flash the device.
              </Alert>
            </div>

            <Stack gap="sm" className="intro">
              <Heading level={1} size="2xl">Flash your RS-Key</Heading>
              <Text tone="muted">
                Pick the right firmware, connect an RP2350 device in BOOTSEL mode, and install it with read-back verification.
              </Text>
            </Stack>

            {!webUsb && (
              <Alert tone="danger" title="WebUSB is not available">
                Use a current Chromium browser on HTTPS or localhost. This browser cannot access a BOOTSEL device.
              </Alert>
            )}
            {releaseError && firmwareSource === "releases" && <Alert tone="danger" title="Releases are unavailable">{releaseError}</Alert>}
            {manifest?.stale && firmwareSource === "releases" && (
              <Alert tone="warning" title="Using cached release data">
                GitHub is unavailable. Cached firmware remains available when it is already mirrored.
              </Alert>
            )}

            <div className="flasher-grid">
              <Card as="section" padding="lg" variant="elevated">
                <Stack gap="lg">
                  <Stack gap="md">
                    <Heading level={2} size="lg">1. Choose firmware</Heading>
                    <RadioGroup name="firmware-source" label="Firmware source" orientation="horizontal" disabled={operationBusy}>
                      <Radio
                        name="firmware-source"
                        value="releases"
                        label="GitHub release"
                        description="Choose a published build"
                        checked={firmwareSource === "releases"}
                        onChange={() => setFirmwareSource("releases")}
                      />
                      <Radio
                        name="firmware-source"
                        value="local"
                        label="Local UF2"
                        description="Use a file from this computer"
                        checked={firmwareSource === "local"}
                        onChange={() => setFirmwareSource("local")}
                      />
                    </RadioGroup>
                    {firmwareSource === "releases" ? (
                      <>
                        <Select
                          label="Release"
                          value={release?.tag || ""}
                          disabled={!visibleReleases.length || operationBusy}
                          onChange={(event) => setReleaseTag(event.target.value)}
                        >
                          {!visibleReleases.length && <option value="">Loading releases…</option>}
                          {visibleReleases.map((item) => (
                            <option key={item.tag} value={item.tag}>
                              {item.tag}{item.prerelease ? " · prerelease" : ""}
                            </option>
                          ))}
                        </Select>
                        <Switch
                          label="Show prereleases"
                          checked={showPrereleases}
                          disabled={operationBusy}
                          onChange={(event) => setShowPrereleases(event.target.checked)}
                        />
                        <Text size="sm" tone="muted">
                          Source: <Link href={RS_KEY_REPOSITORY_URL} external>official RS-Key repository</Link>
                        </Text>
                        {releaseAttestation?.status === "pending" && (
                          <Alert tone="warning" title="Verifying the GitHub release">
                            This browser is checking the keyless release attestation.
                          </Alert>
                        )}
                        {releaseAttestation?.status === "verified" && (
                          <Alert tone="success" title="GitHub release verified" icon={ShieldCheck}>
                            The keyless attestation, Git tag, and all release asset SHA-256 values are valid.
                          </Alert>
                        )}
                        {releaseAttestation?.status === "failed" && (
                          <Alert tone="danger" title="GitHub release attestation failed">
                            {releaseAttestation.error || "This browser could not verify the release."}
                          </Alert>
                        )}
                      </>
                    ) : (
                      <Stack gap="sm">
                        <TextField
                          label="UF2 file"
                          type="file"
                          accept=".uf2,application/octet-stream"
                          disabled={operationBusy}
                          onChange={(event) => {
                            void chooseLocalUf2(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                        <Text size="sm" tone="muted">The file stays in this browser. Its format and SHA-256 are checked before use.</Text>
                        {localError && <Alert tone="danger" title="Invalid UF2">{localError}</Alert>}
                        {localAsset && officialComparisonReady && localOfficialMatch && (
                          <Alert tone="success" title="Official release SHA-256 match" icon={ShieldCheck}>
                            This file matches {localOfficialMatch.asset.name} from release {localOfficialMatch.tag}.
                          </Alert>
                        )}
                        {localAsset && officialComparisonReady && !localOfficialMatch && (
                          <Alert tone="warning" title="This UF2 is not in an official RS-Key release">
                            Its SHA-256 does not match any official release asset. You can continue. If you do not trust this file, download a UF2 from the <Link href={RS_KEY_RELEASES_URL} external>official RS-Key releases</Link>.
                          </Alert>
                        )}
                        {localAsset && officialComparisonFailed && (
                          <Alert tone="warning" title="Official SHA-256 comparison is unavailable">
                            This browser could not verify the complete official release list. You can continue. If you do not trust this file, download a UF2 from the <Link href={RS_KEY_RELEASES_URL} external>official RS-Key releases</Link>.
                          </Alert>
                        )}
                      </Stack>
                    )}
                  </Stack>

                  {firmwareSource === "releases" && <Stack gap="md">
                    <Heading level={2} size="lg">2. Choose a device</Heading>
                    <RadioGroup
                      name="selection-mode"
                      label="Selection mode"
                      orientation="horizontal"
                      disabled={operationBusy}
                    >
                      <Radio
                        name="selection-mode"
                        value="easy"
                        label="Easy picker"
                        description="Answer three questions"
                        checked={mode === "easy"}
                        onChange={() => setMode("easy")}
                      />
                      <Radio
                        name="selection-mode"
                        value="manual"
                        label="All variants"
                        description="Choose the release file"
                        checked={mode === "manual"}
                        onChange={() => setMode("manual")}
                      />
                    </RadioGroup>

                    {mode === "easy" ? (
                      <Stack gap="md" className="picker-questions">
                        <Switch
                          label="Waveshare RP2350-Touch-LCD-2.8 display"
                          description="Select this for the 2.8-inch touch-display board. It uses the 16 MB display image."
                          checked={display}
                          disabled={operationBusy}
                          onChange={(event) => {
                            setDisplay(event.target.checked);
                            if (event.target.checked) {
                              setFlashSize("16");
                              setProfile("default");
                            }
                          }}
                        />
                        <Select
                          label="Flash memory"
                          hint={display ? "The Waveshare display board uses 16 MB." : "Check the board product page if you are not sure."}
                          value={flashSize}
                          disabled={display || operationBusy}
                          onChange={(event) => {
                            setFlashSize(event.target.value);
                            if (event.target.value !== "4") setProfile("default");
                          }}
                        >
                          <option value="2">2 MB</option>
                          <option value="4">4 MB</option>
                          <option value="16">16 MB</option>
                        </Select>
                        <Select
                          label="Firmware profile"
                          hint={display || flashSize !== "4" ? "Extra policy profiles use the 4 MB layout." : "Choose the security and algorithm policy."}
                          value={effectiveProfile}
                          disabled={display || flashSize !== "4" || !profiles.length || operationBusy}
                          onChange={(event) => setProfile(event.target.value)}
                        >
                          {profiles.map((item) => <option key={item} value={item}>{variantLabel(item)}</option>)}
                        </Select>
                      </Stack>
                    ) : (
                      <Select
                        label="Firmware variant"
                        value={effectiveManualVariant}
                        disabled={!assets.length || operationBusy}
                        onChange={(event) => setManualVariant(event.target.value)}
                      >
                        {assets.map((asset) => (
                          <option key={asset.id} value={asset.variant}>{variantLabel(asset.variant)}</option>
                        ))}
                      </Select>
                    )}
                  </Stack>}
                </Stack>
              </Card>

              <Stack gap="md">
                <Card as="section" padding="lg" variant="outlined">
                  <Stack gap="md">
                    <Heading level={2} size="lg">{firmwareSource === "releases" ? "3" : "2"}. Connect and flash</Heading>
                    {selectedAsset ? (
                      <Stack gap="sm" className="recommendation">
                        <Inline gap="sm" align="center">
                          <CheckCircle2 aria-hidden size={19} />
                          <Text as="span"><strong>{firmwareSource === "local" ? "Local UF2" : variantLabel(selectedAsset.variant)}</strong></Text>
                        </Inline>
                        <Text size="sm" tone="muted" className="filename">{selectedAsset.name}</Text>
                      </Stack>
                    ) : (
                      <Alert tone="danger" title="No matching image">
                        {firmwareSource === "local"
                          ? "Choose a valid local UF2 file."
                          : "This release does not contain the selected variant. Choose another release or use the manual picker."}
                      </Alert>
                    )}

                    <ol className="bootsel-steps">
                      <li>Disconnect the RP2350 device.</li>
                      <li>Hold its BOOT or BOOTSEL button.</li>
                      <li>Connect USB, then release the button.</li>
                    </ol>

                    <Alert tone="warning" title="Check the flash size">
                      A wrong 2 MB, 4 MB, 16 MB, or display image can use the wrong storage layout. Secure-boot devices need a UF2 sealed with their own key.
                    </Alert>

                    <Inline gap="sm" wrap>
                      <Button
                        startIcon={Usb}
                        size="lg"
                        loading={busy}
                        disabled={!webUsb || !selectedAsset || operationBusy ||
                          (firmwareSource === "releases" && !releaseTrusted)}
                        onClick={startFlash}
                      >
                        {busy ? "Flashing…" : "Connect and flash"}
                      </Button>
                      {firmwareSource === "releases" && (
                        <Button
                          startIcon={DownloadIcon}
                          size="lg"
                          variant="secondary"
                          loading={downloadBusy}
                          disabled={!selectedAsset || operationBusy || !releaseTrusted}
                          onClick={() => void startDownload()}
                        >
                          {downloadBusy ? "Downloading…" : "Download original UF2"}
                        </Button>
                      )}
                    </Inline>

                    {(busy || progress > 0) && (
                      <Progress value={progress} max={100} label={status} showValue animated={busy || downloadBusy} />
                    )}
                    {error && <Alert tone="danger" title="Operation failed">{error}</Alert>}
                    {success && <Alert tone="success" title="Operation verified" icon={ShieldCheck}>{success}</Alert>}
                  </Stack>
                </Card>
              </Stack>
            </div>

            <SecurityTools
              asset={selectedAsset}
              localFirmware={firmwareSource === "local" ? localBytes || undefined : undefined}
              webUsb={webUsb}
              rawFlashEpoch={rawFlashEpoch}
              externalBusy={busy || downloadBusy}
              operationLockRef={operationLock}
              onBusyChange={setSecurityBusy}
              releaseAssetTrusted={firmwareSource === "local" || releaseTrusted}
              directGitHub={directGitHub}
            />

            <footer className="site-footer">
              <Inline gap="md" justify="center" align="center" wrap>
                <Text as="span" size="sm" tone="subtle">
                  Firmware by <Link href="https://github.com/TheMaxMur/RS-Key" external>RS-Key</Link>
                  {" · "}
                  Implemented by <Link href="https://cofob.dev/" external>cofob</Link>
                  {" · "}
                  <Link href="https://github.com/cofob/rs-key-flasher" external>Source code</Link>
                </Text>
                <Switch
                  className="api-source-switch"
                  label="Direct GitHub API"
                  checked={directGitHub}
                  onChange={(event) => changeApiSource(event.target.checked)}
                />
              </Inline>
            </footer>
          </Stack>
        </Container>
      </main>
    </AppShell>
  );
}
