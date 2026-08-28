"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { readSecureBootOtpState } from "../lib/otp";
import { flashUf2, hasWebUsb, requestPicobootDevice, type FlashStage } from "../lib/picoboot";
import { RS_KEY_RELEASES_URL } from "../lib/release-attestation";
import {
  findOfficialAssetBySha256,
  firmwareProfiles,
  recommendVariant,
  variantLabel,
  type FirmwareAsset,
  type LocalFirmwareAsset,
  type Release,
} from "../lib/releases";
import { parseUf2 } from "../lib/uf2";
import { SecurityTools } from "./security-tools";

type SelectionMode = "easy" | "manual";
type FirmwareSource = "remote" | "local";

const MAX_LOCAL_UF2_SIZE = 32 * 1024 * 1024;
const THEMES: ThemePreference[] = ["system", "light", "dark"];
const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

const STAGE_LABELS: Record<FlashStage, string> = {
  connect: "Connecting to picoboot…",
  erase: "Erasing firmware sectors…",
  write: "Writing firmware…",
  verify: "Reading back and verifying…",
  reboot: "Rebooting RS-Key…",
};

export interface FirmwareWorkbenchProps {
  title: string;
  description: string;
  remoteLabel: string;
  remoteDescription: string;
  assets: FirmwareAsset[];
  remoteTrusted: boolean;
  catalog: ReactNode;
  notices?: ReactNode;
  directGitHub?: boolean;
  officialReleases?: Release[];
  officialComparisonReady?: boolean;
  officialComparisonFailed?: boolean;
  footerControls?: ReactNode;
  footerNavigation?: ReactNode;
}

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

export function FirmwareWorkbench({
  title,
  description,
  remoteLabel,
  remoteDescription,
  assets,
  remoteTrusted,
  catalog,
  notices,
  directGitHub = false,
  officialReleases = [],
  officialComparisonReady = false,
  officialComparisonFailed = false,
  footerControls,
  footerNavigation,
}: FirmwareWorkbenchProps) {
  const [firmwareSource, setFirmwareSource] = useState<FirmwareSource>("remote");
  const [localAsset, setLocalAsset] = useState<LocalFirmwareAsset | null>(null);
  const [localBytes, setLocalBytes] = useState<Uint8Array | null>(null);
  const [localError, setLocalError] = useState("");
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
    Promise.resolve().then(() => setWebUsb(hasWebUsb()));
  }, []);
  useEffect(() => {
    if (!busy) return;
    const percent = Math.round(progress);
    const signature = `${status}:${percent}`;
    if (flashLogRef.current === signature) return;
    flashLogRef.current = signature;
    console.info(`[RS-Key][flasher] ${status}`, { progress: percent });
  }, [busy, progress, status]);
  useEffect(() => { if (error) console.error("[RS-Key][flasher] Operation failed", { error }); }, [error]);
  useEffect(() => { if (success) console.info("[RS-Key][flasher] Operation completed", { message: success }); }, [success]);

  const profiles = useMemo(() => firmwareProfiles(assets), [assets]);
  const effectiveProfile = profiles.includes(profile) ? profile : "default";
  const easyVariant = recommendVariant(display, flashSize, effectiveProfile);
  const effectiveManualVariant = assets.some((asset) => asset.variant === manualVariant)
    ? manualVariant
    : assets.find((asset) => asset.variant === "default")?.variant || assets[0]?.variant || "";
  const variant = mode === "easy" ? easyVariant : effectiveManualVariant;
  const remoteAsset = assets.find((asset) => asset.variant === variant);
  const selectedAsset = firmwareSource === "local" ? localAsset || undefined : remoteAsset;
  const localOfficialMatch = localAsset && officialComparisonReady
    ? findOfficialAssetBySha256(officialReleases, localAsset.sha256)
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
        source: "local",
        id: 0,
        name: file.name,
        size: bytes.length,
        sha256,
        version: "local",
        variant: "custom",
      });
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "Could not read the local UF2 file.");
    }
  }

  async function startDownload(): Promise<void> {
    if (!remoteAsset || firmwareSource !== "remote" || operationLock.current) return;
    if (!remoteTrusted) {
      setError("The selected firmware metadata is not trusted.");
      return;
    }
    operationLock.current = true;
    setRawFlashEpoch((value) => value + 1);
    setDownloadBusy(true);
    setError("");
    setSuccess("");
    setProgress(1);
    setStatus("Downloading and checking the UF2…");
    try {
      const bytes = await downloadVerifiedAsset(remoteAsset, (value) => setProgress(1 + value * 99), directGitHub);
      downloadBytes(remoteAsset.name, bytes);
      setProgress(100);
      setStatus("SHA-256 verified");
      setSuccess(`${remoteAsset.name} was verified and downloaded.`);
    } catch (reason) {
      setStatus("Stopped");
      setError(reason instanceof Error ? reason.message : "Firmware download failed.");
    } finally {
      setDownloadBusy(false);
      operationLock.current = false;
    }
  }

  async function startFlash(): Promise<void> {
    if (!selectedAsset || operationLock.current) return;
    if (firmwareSource === "remote" && !remoteTrusted) {
      setError("The selected firmware metadata is not trusted.");
      return;
    }

    flashLogRef.current = "";
    console.info("[RS-Key][flasher] Flash started", { firmware: selectedAsset.name, source: selectedAsset.source });
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
              <Heading level={1} size="2xl">{title}</Heading>
              <Text tone="muted">{description}</Text>
            </Stack>

            {notices}
            {!webUsb && (
              <Alert tone="danger" title="WebUSB is not available">
                Use a current Chromium browser on HTTPS or localhost. This browser cannot access a BOOTSEL device.
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
                        value="remote"
                        label={remoteLabel}
                        description={remoteDescription}
                        checked={firmwareSource === "remote"}
                        onChange={() => setFirmwareSource("remote")}
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
                    {firmwareSource === "remote" ? catalog : (
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
                            Its SHA-256 does not match any official release asset. You can continue. If you do not trust this file, use the <Link href={RS_KEY_RELEASES_URL} external>official releases</Link>.
                          </Alert>
                        )}
                        {localAsset && officialComparisonFailed && (
                          <Alert tone="warning" title="Official SHA-256 comparison is unavailable">
                            This browser could not verify the complete official release list. You can continue only if you trust this file.
                          </Alert>
                        )}
                      </Stack>
                    )}
                  </Stack>

                  {firmwareSource === "remote" && (
                    <Stack gap="md">
                      <Heading level={2} size="lg">2. Choose a device</Heading>
                      <RadioGroup name="selection-mode" label="Selection mode" orientation="horizontal" disabled={operationBusy}>
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
                          description="Choose the firmware file"
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
                            <option key={`${asset.source}-${asset.id}`} value={asset.variant}>{variantLabel(asset.variant)}</option>
                          ))}
                        </Select>
                      )}
                    </Stack>
                  )}
                </Stack>
              </Card>

              <Stack gap="md">
                <Card as="section" padding="lg" variant="outlined">
                  <Stack gap="md">
                    <Heading level={2} size="lg">{firmwareSource === "remote" ? "3" : "2"}. Connect and flash</Heading>
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
                          : "This build does not contain the selected variant. Choose another build or use the manual picker."}
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
                        disabled={!webUsb || !selectedAsset || operationBusy || (firmwareSource === "remote" && !remoteTrusted)}
                        onClick={() => void startFlash()}
                      >
                        {busy ? "Flashing…" : "Connect and flash"}
                      </Button>
                      {firmwareSource === "remote" && (
                        <Button
                          startIcon={DownloadIcon}
                          size="lg"
                          variant="secondary"
                          loading={downloadBusy}
                          disabled={!selectedAsset || operationBusy || !remoteTrusted}
                          onClick={() => void startDownload()}
                        >
                          {downloadBusy ? "Downloading…" : "Download UF2"}
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
              assetTrusted={firmwareSource === "local" || remoteTrusted}
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
                  {footerNavigation && <> · {footerNavigation}</>}
                </Text>
                {footerControls}
              </Inline>
            </footer>
          </Stack>
        </Container>
      </main>
    </AppShell>
  );
}
