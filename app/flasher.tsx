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
import { assetUrl, downloadVerifiedAsset, sha256Hex } from "../lib/assets";
import { flashUf2, hasWebUsb, requestPicobootDevice, type FlashStage } from "../lib/picoboot";
import { readSecureBootOtpState } from "../lib/otp";
import {
  firmwareAssets,
  firmwareProfiles,
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

const API_SOURCE_KEY = "rs-key-flasher-api-source";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/TheMaxMur/RS-Key/releases?per_page=100";
const MAX_LOCAL_UF2_SIZE = 32 * 1024 * 1024;

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
  const [mode, setMode] = useState<SelectionMode>("easy");
  const [display, setDisplay] = useState(false);
  const [flashSize, setFlashSize] = useState("4");
  const [profile, setProfile] = useState("default");
  const [manualVariant, setManualVariant] = useState("default");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [webUsb, setWebUsb] = useState(true);
  const [rawFlashEpoch, setRawFlashEpoch] = useState(0);
  const [securityBusy, setSecurityBusy] = useState(false);
  const operationLock = useRef(false);
  const flashLogRef = useRef("");
  const operationBusy = busy || securityBusy;

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
    fetch(releasesUrl, useDirectGitHub ? { headers: { Accept: "application/vnd.github+json" } } : undefined)
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
      .then((data) => {
        setManifest(data);
        const stable = data.releases.find((release) => !release.prerelease);
        setReleaseTag(stable?.tag || data.releases[0]?.tag || "");
      })
      .catch((reason) => setReleaseError(reason instanceof Error ? reason.message : "Could not load releases."));
  }, []);

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

  function startDownload() {
    if (!releaseAsset || firmwareSource !== "releases" || operationLock.current) return;
    setRawFlashEpoch((value) => value + 1);
    const link = document.createElement("a");
    link.href = assetUrl(releaseAsset, directGitHub);
    link.download = releaseAsset.name;
    link.click();
  }

  async function startFlash() {
    if (!selectedAsset || operationLock.current) return;

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
        : await downloadVerifiedAsset(selectedAsset, (value) => setProgress(5 + value * 20));
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
                        disabled={!webUsb || !selectedAsset || operationBusy}
                        onClick={startFlash}
                      >
                        {busy ? "Flashing…" : "Connect and flash"}
                      </Button>
                      {firmwareSource === "releases" && (
                        <Button
                          startIcon={DownloadIcon}
                          size="lg"
                          variant="secondary"
                          disabled={!selectedAsset || operationBusy}
                          onClick={startDownload}
                        >
                          Download original UF2
                        </Button>
                      )}
                    </Inline>

                    {(busy || progress > 0) && (
                      <Progress value={progress} max={100} label={status} showValue animated={busy} />
                    )}
                    {error && <Alert tone="danger" title="Flash failed">{error}</Alert>}
                    {success && <Alert tone="success" title="Flash verified" icon={ShieldCheck}>{success}</Alert>}
                  </Stack>
                </Card>
              </Stack>
            </div>

            <SecurityTools
              asset={selectedAsset}
              localFirmware={firmwareSource === "local" ? localBytes || undefined : undefined}
              webUsb={webUsb}
              rawFlashEpoch={rawFlashEpoch}
              externalBusy={busy}
              operationLockRef={operationLock}
              onBusyChange={setSecurityBusy}
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
