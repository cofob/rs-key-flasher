"use client";

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Heading,
  Inline,
  Link,
  Progress,
  Stack,
  Switch,
  Text,
  Textarea,
  TextField,
} from "@cofob/design-system-react/static";
import { Copy, Download, KeyRound, ShieldCheck, Usb } from "lucide-react";
import { Dialog, useToast } from "@cofob/design-system-react/client";
import { downloadVerifiedAsset, sha256Hex } from "../lib/assets";
import {
  parseRskStatusJson,
  type RskSecureBootStatus,
} from "../lib/rsk-status";
import { rp2350SerialsMatch } from "../lib/device-serial";
import {
  burnPage58Secrets,
  enableSecureBoot,
  hardenSecureBoot,
  loadBootKeyFingerprint,
  lockSecureBootPages,
  readSecureBootOtpState,
  type SecureBootOtpState,
} from "../lib/otp";
import { sealUf2, type SealedUf2 } from "../lib/picobin";
import { flashUf2, requestPicobootDevice, type FlashStage } from "../lib/picoboot";
import type { FirmwareAsset } from "../lib/releases";
import {
  clearSecureBootKey,
  generateSecureBootKey,
  importSecureBootMnemonic,
  importSecureBootPem,
  type SecureBootKey,
} from "../lib/secure-boot-key";
import { parseUf2 } from "../lib/uf2";

interface SignedResult extends SealedUf2 {
  context: string;
  filename: string;
  sha256: string;
  original: Uint8Array;
  deviceSerial?: string;
  rollbackFloor?: number;
}

interface SecurityToolsProps {
  asset?: FirmwareAsset;
  localFirmware?: Uint8Array;
  webUsb: boolean;
  rawFlashEpoch: number;
  externalBusy: boolean;
  operationLockRef: MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
  releaseAssetTrusted: boolean;
  directGitHub: boolean;
}

interface ProvisioningStepProps {
  number: number;
  title: string;
  mode: "BOOTSEL" | "running firmware";
  state: "complete" | "ready" | "attention";
  description: string;
  children: ReactNode;
}

interface PendingConfirmation {
  token: string;
  title: string;
  consequence: string;
  action: () => void;
}

function ProvisioningStep({ number, title, mode, state, description, children }: ProvisioningStepProps) {
  const stateLabel = state === "complete" ? "Complete" : state === "ready" ? "Ready" : "Check requirements";
  return (
    <Card as="section" padding="md" variant="outlined" className="provisioning-step" data-state={state}>
      <Stack gap="md">
        <Inline justify="between" align="start" gap="md" wrap>
          <Stack gap="sm">
            <Text as="span" size="sm" tone="muted">Step {number} · {mode}</Text>
            <Heading level={4} size="md">{title}</Heading>
          </Stack>
          <span className="provisioning-step__state" data-state={state}>{stateLabel}</span>
        </Inline>
        <Text size="sm" tone="muted">{description}</Text>
        {children}
      </Stack>
    </Card>
  );
}

const STAGE_LABELS: Record<FlashStage, string> = {
  connect: "Connecting to picoboot…",
  erase: "Erasing firmware sectors…",
  write: "Writing signed firmware…",
  verify: "Reading back and verifying…",
  reboot: "Rebooting RS-Key…",
};

const SECURITY_TOAST_ID = "security-operation";
const RS_KEY_DOCS = {
  threatModel: "https://themaxmur.github.io/RS-Key/threat-model.html",
  production: "https://themaxmur.github.io/RS-Key/production.html",
  signingKeys: "https://themaxmur.github.io/RS-Key/signing-keys.html",
  otpFuses: "https://themaxmur.github.io/RS-Key/otp-fuses.html",
  antiRollback: "https://themaxmur.github.io/RS-Key/anti-rollback.html",
} as const;
const RSK_COMMANDS = {
  status: "uvx --from ./tools rsk status --json",
  lockPage58: "uvx --from ./tools rsk otp lock-page58",
  requireRollback: "uvx --from ./tools rsk otp rollback-require",
} as const;

function flashPercent(stage: FlashStage, completed: number, total: number): number {
  const ratio = total ? completed / total : 0;
  if (stage === "connect") return ratio * 5;
  if (stage === "erase") return 5 + ratio * 20;
  if (stage === "write") return 25 + ratio * 35;
  if (stage === "verify") return 60 + ratio * 35;
  return 95 + ratio * 5;
}

function serialsMatch(left: string, right: string): boolean {
  return rp2350SerialsMatch(left, right);
}

function downloadBlob(name: string, contents: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importKey(value: string): Promise<SecureBootKey> {
  return value.includes("BEGIN EC PRIVATE KEY")
    ? importSecureBootPem(value)
    : importSecureBootMnemonic(value);
}

function formatBytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function stateSummary(state: SecureBootOtpState): string {
  const trusted = state.trustedSlots.length ? state.trustedSlots.join(", ") : "none";
  return `serial ${state.serial} · secure boot ${state.secureBootEnabled ? "enabled" : "off"} · trusted slots ${trusted} · rollback ${state.rollbackRequired ? "required" : "optional"} ${state.bootVersion}/48 · page 58 ${state.page58}`;
}

export function SecurityTools({
  asset,
  localFirmware,
  webUsb,
  rawFlashEpoch,
  externalBusy,
  operationLockRef,
  onBusyChange,
  releaseAssetTrusted,
  directGitHub,
}: SecurityToolsProps) {
  const { toast, dismiss } = useToast();
  const operationNameRef = useRef("Security operation");
  const stageLogRef = useRef("");
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState<SecureBootKey | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [useRollback, setUseRollback] = useState(false);
  const [rollbackVersion, setRollbackVersion] = useState("1");
  const [signedResult, setSignedResult] = useState<SignedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState("");
  const [status, setStatus] = useState("Ready");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [otp, setOtp] = useState<SecureBootOtpState | null>(null);
  const [boundSerial, setBoundSerial] = useState("");
  const [cliStatus, setCliStatus] = useState<RskSecureBootStatus | null>(null);
  const [cliJson, setCliJson] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [negativeTestStartedContext, setNegativeTestStartedContext] = useState("");
  const [negativeTestPassedContext, setNegativeTestPassedContext] = useState("");
  const [rollbackTestStartedContext, setRollbackTestStartedContext] = useState("");
  const [rollbackTestPassedContext, setRollbackTestPassedContext] = useState("");
  const operationBusy = busy || externalBusy;

  useEffect(() => {
    if (!busy) return;
    const percent = Math.round(progress);
    const signature = `${operationNameRef.current}:${status}:${percent}`;
    if (stageLogRef.current === signature) return;
    stageLogRef.current = signature;
    console.info(`[RS-Key][security] ${operationNameRef.current}: ${status}`, { progress: percent });
  }, [busy, progress, status]);

  useEffect(() => {
    if (error) console.error(`[RS-Key][security] ${operationNameRef.current}: failed`, { error });
  }, [error]);

  useEffect(() => {
    if (success) console.info(`[RS-Key][security] ${operationNameRef.current}: completed`, { message: success });
  }, [success]);

  useEffect(() => {
    if (error) {
      toast({
        id: SECURITY_TOAST_ID,
        title: "Security operation stopped",
        description: error,
        tone: "danger",
        duration: 8000,
      });
      return;
    }
    if (success) {
      toast({
        id: SECURITY_TOAST_ID,
        title: "Security operation complete",
        description: success,
        tone: "success",
      });
      return;
    }
    if (busy || progress > 0) {
      toast({
        id: SECURITY_TOAST_ID,
        title: status,
        description: <Progress value={progress} max={100} label={status} showValue animated={busy} />,
        tone: "info",
        duration: 0,
      });
    }
  }, [busy, error, progress, status, success, toast]);

  useEffect(() => () => dismiss(SECURITY_TOAST_ID), [dismiss]);

  // A signed image is determined by its firmware bytes, signer and declared
  // rollback version. Device identity and its mutable floor are verified when
  // the image is flashed, so inspecting OTP must not invalidate the artifact.
  const signingContext = `${asset?.id ?? "none"}:${asset?.sha256 || "none"}:${key?.fingerprint || "none"}:${useRollback ? rollbackVersion : "none"}`;
  const workflowContext = `${rawFlashEpoch}:${signingContext}`;
  const signed = signedResult?.context === signingContext ? signedResult : null;
  const negativeTestStarted = negativeTestStartedContext === workflowContext;
  const negativeTestPassed = negativeTestPassedContext === workflowContext;
  const rollbackTestStarted = rollbackTestStartedContext === workflowContext;
  const rollbackTestPassed = rollbackTestPassedContext === workflowContext;
  const inspectedPage58Blank = Boolean(otp?.consistent && otp.page58 === "blank" && boundSerial && serialsMatch(otp.serial, boundSerial));
  const inspectedPage58Present = Boolean(otp?.consistent && otp.page58 === "present" && boundSerial && serialsMatch(otp.serial, boundSerial));
  const inspectedPage58Locked = Boolean(otp?.consistent && otp.page58 === "locked" && boundSerial && serialsMatch(otp.serial, boundSerial));
  const burnToken = inspectedPage58Blank ? `BURN-OTP-PAGE58-${otp!.serial}` : "BURN-OTP-PAGE58-<SERIAL>";
  const hasTrustedBootKey = Boolean(otp?.trustedSlots.length);
  const hardened = Boolean(otp?.debugDisabled && otp.glitchDetectorEnabled && otp.glitchSensitivity === 3);

  function beginOperation(name: string): boolean {
    if (operationLockRef.current) {
      console.warn(`[RS-Key][security] ${name}: skipped because another operation is active`);
      return false;
    }
    operationNameRef.current = name;
    stageLogRef.current = "";
    console.info(`[RS-Key][security] ${name}: started`);
    setError("");
    setSuccess("");
    setStatus(`${name}…`);
    setProgress(0);
    setActiveOperation(name);
    operationLockRef.current = true;
    setBusy(true);
    onBusyChange(true);
    return true;
  }

  function endOperation(): void {
    setBusy(false);
    setActiveOperation("");
    onBusyChange(false);
    operationLockRef.current = false;
  }

  function acceptOtpState(state: SecureBootOtpState): void {
    setOtp(state);
    if (state.rollbackRequired) {
      setUseRollback(true);
      setRollbackVersion(String(Math.max(1, state.bootVersion)));
    }
  }

  function replaceKey(next: SecureBootKey): void {
    if (key) clearSecureBootKey(key);
    setKey(next);
    setSignedResult(null);
    setCliStatus(null);
    setKeyInput("");
    setError("");
  }

  async function generateKey(): Promise<void> {
    if (!beginOperation("Generate signing key")) return;
    try {
      replaceKey(await generateSecureBootKey());
      setSuccess("A new per-device signing key was generated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Key generation failed.");
    } finally {
      endOperation();
    }
  }

  async function importOrVerifyKey(): Promise<void> {
    if (!keyInput.trim()) return;
    if (!beginOperation("Import or verify signing key")) return;
    setError("");
    try {
      const imported = await importKey(keyInput);
      if (key && imported.fingerprint !== key.fingerprint) {
        clearSecureBootKey(imported);
        throw new Error("This backup belongs to a different signing key.");
      }
      if (key) {
        clearSecureBootKey(key);
        setKey(imported);
        setKeyInput("");
        setSuccess("The imported private key matches this session.");
      } else {
        replaceKey(imported);
        setSuccess("Signing key imported for an update.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Key import failed.");
    } finally {
      endOperation();
    }
  }

  async function readKeyFile(file?: File): Promise<void> {
    if (!file) return;
    setKeyInput(await file.text());
  }

  function exportPem(): void {
    if (!key) return;
    downloadBlob(`rs-key-${key.fingerprint.slice(0, 8)}-secure-boot.pem`, key.pem, "application/x-pem-file");
    setKeyInput("");
  }

  function exportMnemonic(): void {
    if (!key) return;
    downloadBlob(`rs-key-${key.fingerprint.slice(0, 8)}-secure-boot.mnemonic.txt`, `${key.mnemonic}\n`, "text/plain");
    setKeyInput("");
  }

  async function createSignedUf2(): Promise<void> {
    if (!asset || !key) return;
    if (!releaseAssetTrusted) {
      setError("The GitHub release attestation has not been verified in this browser.");
      return;
    }
    if (!beginOperation("Create signed UF2")) return;
    setError("");
    setSuccess("");
    setProgress(1);
    try {
      setStatus(localFirmware ? "Checking local firmware…" : "Downloading and checking original firmware…");
      const original = localFirmware
        ? localFirmware.slice()
        : await downloadVerifiedAsset(asset, (value) => setProgress(1 + value * 39), directGitHub);
      if (original.length !== asset.size || await sha256Hex(original) !== asset.sha256) {
        throw new Error("The firmware bytes do not match the selected SHA-256 and size.");
      }
      if (localFirmware) setProgress(40);
      const version = useRollback ? Number(rollbackVersion) : undefined;
      if (version !== undefined) {
        if (!Number.isInteger(version) || version < 1 || version > 48) {
          throw new Error("Rollback version must be an integer from 1 to 48.");
        }
        if (otp && (version < Math.max(1, otp.bootVersion) || version > otp.bootVersion + 1)) {
          throw new Error(`For this device use rollback version ${Math.max(1, otp.bootVersion)} or ${otp.bootVersion + 1}.`);
        }
      }
      setStatus("Creating signed picobin image…");
      const sealed = await sealUf2(original, key, version);
      setProgress(85);
      const stem = asset.name.replace(/\.uf2$/i, "");
      const filename = `${stem}-signed-${key.fingerprint.slice(0, 8)}${version === undefined ? "" : `-v${version}`}.uf2`;
      const result: SignedResult = {
        ...sealed,
        context: signingContext,
        filename,
        sha256: await sha256Hex(sealed.bytes),
        original,
        deviceSerial: version === undefined ? undefined : otp?.serial,
        rollbackFloor: version === undefined ? undefined : otp?.bootVersion,
      };
      setSignedResult(result);
      setProgress(100);
      setStatus("Signed UF2 ready");
      setSuccess(`${filename} was sealed and its signature was verified in this browser. Flash it once, then continue down the provisioning steps.`);
    } catch (reason) {
      setStatus("Stopped");
      setError(reason instanceof Error ? reason.message : "UF2 signing failed.");
    } finally {
      endOperation();
    }
  }

  function ensureDevice(state: SecureBootOtpState): void {
    if (!state.consistent) throw new Error(state.problems.join(" "));
    if (boundSerial && !serialsMatch(boundSerial, state.serial)) throw new Error("A different RP2350 device was selected.");
    if (cliStatus && !serialsMatch(cliStatus.serial, state.serial)) throw new Error("The rsk status belongs to a different device.");
  }

  function ensureTrustedSigner(state: SecureBootOtpState): void {
    if (!key || !state.trustedSlots.length) return;
    const matchingSlot = state.trustedSlots.find((slot) => state.fingerprints[slot] === key.fingerprint);
    if (matchingSlot === undefined) throw new Error("This key does not match a trusted secure-boot slot on the device.");
  }

  function validateSignedArtifact(state: SecureBootOtpState): void {
    if (!signed) throw new Error("Create the signed UF2 before this action.");
    ensureDevice(state);
    ensureTrustedSigner(state);
    if (signed.rollbackVersion !== undefined) {
      if (signed.rollbackVersion < Math.max(1, state.bootVersion) || signed.rollbackVersion > state.bootVersion + 1) {
        throw new Error(`For this device use rollback version ${Math.max(1, state.bootVersion)} or ${Math.min(48, state.bootVersion + 1)}.`);
      }
    } else if (state.rollbackRequired) {
      throw new Error(`This device requires rollback version ${state.bootVersion} or later.`);
    }
  }

  function downloadSignedUf2(): void {
    if (!signed || operationLockRef.current) return;
    downloadBlob(signed.filename, signed.bytes.slice().buffer as ArrayBuffer, "application/octet-stream");
  }

  async function inspectDevice(): Promise<void> {
    if (!beginOperation("Inspect BOOTSEL OTP")) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      if (!state.consistent) throw new Error(state.problems.join(" "));
      if (boundSerial && !serialsMatch(boundSerial, state.serial)) throw new Error("A different RP2350 device was selected.");
      setBoundSerial(state.serial);
      acceptOtpState(state);
      setSuccess(`Device inspected: ${stateSummary(state)}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Device inspection failed.");
    } finally {
      endOperation();
    }
  }

  async function flashSigned(): Promise<void> {
    if (!signed || !key) return;
    if (!beginOperation("Flash signed UF2")) return;
    setError("");
    setSuccess("");
    setProgress(1);
    try {
      const device = await requestPicobootDevice();
      setStatus("Checking device OTP…");
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      const raisesFloor = signed.rollbackVersion !== undefined && signed.rollbackVersion === state.bootVersion + 1;
      if (raisesFloor) {
        console.info(`[RS-Key][security] Flash signed UF2: rollback floor will advance from ${state.bootVersion} to ${signed.rollbackVersion}`);
      }
      setBoundSerial(state.serial);
      acceptOtpState(state);
      await flashUf2(device, signed.image, (stage, completed, total) => {
        setStatus(STAGE_LABELS[stage]);
        setProgress(flashPercent(stage, completed, total));
      });
      setCliStatus(null);
      setStatus("Signed flash verified");
      setProgress(100);
      setSuccess("The signed image was written, read back, verified, and started. Continue to BOOTSEL inspection and provisioning.");
    } catch (reason) {
      setStatus("Stopped");
      setError(reason instanceof Error ? reason.message : "Signed flashing failed.");
    } finally {
      endOperation();
    }
  }

  function validateCliStatus(): void {
    operationNameRef.current = "Read rsk CLI status";
    console.info("[RS-Key][security] Read rsk CLI status: started");
    try {
      const proof = parseRskStatusJson(cliJson);
      if (boundSerial && !serialsMatch(boundSerial, proof.serial)) throw new Error("The CLI status belongs to a different device.");
      setBoundSerial((current) => current || proof.serial);
      setCliStatus(proof);
      setError("");
      setSuccess(`rsk status accepted for device ${proof.serial}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the rsk status output.");
    }
  }

  async function copyCliCommand(command: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      console.info(`[RS-Key][security] ${label}: CLI command copied`);
      toast({
        title: "rsk command copied",
        description: label,
        tone: "success",
      });
    } catch {
      toast({
        title: "Could not copy the command",
        description: "Select the command and copy it manually.",
        tone: "danger",
      });
    }
  }

  function requestIrreversibleAction(confirmationRequest: PendingConfirmation): void {
    console.info(`[RS-Key][security] ${confirmationRequest.token}: confirmation requested`);
    setConfirmation("");
    setPendingConfirmation(confirmationRequest);
  }

  function closeConfirmation(): void {
    setPendingConfirmation(null);
    setConfirmation("");
  }

  function confirmIrreversibleAction(): void {
    if (!pendingConfirmation || confirmation !== pendingConfirmation.token) return;
    const { token, action } = pendingConfirmation;
    console.info(`[RS-Key][security] ${token}: confirmation accepted`);
    closeConfirmation();
    action();
  }

  async function copyConfirmationToken(): Promise<void> {
    if (!pendingConfirmation) return;
    try {
      await navigator.clipboard.writeText(pendingConfirmation.token);
      console.info(`[RS-Key][security] ${pendingConfirmation.token}: confirmation token copied`);
      toast({
        title: "Confirmation token copied",
        description: "Paste the token into the field to enable the permanent action.",
        tone: "success",
      });
    } catch {
      toast({
        title: "Could not copy the token",
        description: "Select the token and copy it manually.",
        tone: "danger",
      });
    }
  }

  async function runOtpAction(
    token: string,
    action: (device: USBDevice) => Promise<SecureBootOtpState | { state: SecureBootOtpState }>,
    options: { signedImage?: boolean; negativeTest?: boolean; bootAfter?: boolean; page58?: "blank" | "present" | "locked" } = {},
  ): Promise<void> {
    if (options.page58 && (!otp || !otp.consistent || otp.page58 !== options.page58 || !serialsMatch(otp.serial, boundSerial))) {
      setError(`Inspect and bind the target BOOTSEL device with page 58 ${options.page58} before this action.`);
      return;
    }
    if (options.signedImage && !signed) {
      setError("Create and boot the signed UF2 before this action.");
      return;
    }
    if (options.negativeTest && !negativeTestPassed) {
      setError("Complete the unsigned-image rejection test before the full lock.");
      return;
    }
    if (!beginOperation(token)) return;
    setError("");
    setSuccess("");
    try {
      const device = await requestPicobootDevice();
      const before = await readSecureBootOtpState(device);
      ensureDevice(before);
      if (options.signedImage) validateSignedArtifact(before);
      if (options.page58 && before.page58 !== options.page58) {
        throw new Error(`Page 58 must be ${options.page58} before this action; it is ${before.page58}.`);
      }
      setBoundSerial(before.serial);
      const result = await action(device);
      const state = "state" in result ? result.state : result;
      acceptOtpState(state);
      setCliStatus(null);
      setSuccess(options.bootAfter
        ? `${token} completed and verified. Boot the signed image once before the next rejection test.`
        : `${token} completed and verified.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${token} failed.`);
    } finally {
      endOperation();
    }
  }

  async function startNegativeTest(): Promise<void> {
    if (!signed || !otp?.secureBootEnabled) {
      setError("A signed image and BOOTSEL confirmation that Secure Boot is enabled are required for the rejection test.");
      return;
    }
    if (!beginOperation("Unsigned-image rejection test")) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.secureBootEnabled) throw new Error("Secure boot is not enabled.");
      await flashUf2(device, parseUf2(signed.original), (stage, completed, total) => {
        setStatus(`Unsigned test: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setNegativeTestStartedContext(workflowContext);
      setNegativeTestPassedContext("");
      setCliStatus(null);
      setSuccess("Unsigned image written. A working secure-boot device must return to BOOTSEL. Use Restore signed image next.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unsigned rejection test failed.");
    } finally {
      endOperation();
    }
  }

  async function restoreAfterNegativeTest(): Promise<void> {
    if (!negativeTestStarted) {
      setError("Run the unsigned-image rejection test before restoring the signed image.");
      return;
    }
    if (!signed) {
      setError("Create the signed UF2 before restoring it.");
      return;
    }
    if (!beginOperation("Restore signed image")) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.secureBootEnabled) throw new Error("The selected BOOTSEL device is not the enforced secure-boot device.");
      await flashUf2(device, signed.image, (stage, completed, total) => {
        setStatus(`Restore: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setNegativeTestPassedContext(workflowContext);
      setCliStatus(null);
      setSuccess("The unsigned image was rejected and the signed image was restored. Continue to the final Secure Boot lock.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Signed image restore failed.");
    } finally {
      endOperation();
    }
  }

  async function startVersionlessRollbackTest(): Promise<void> {
    if (!key) {
      setError("Import the Secure Boot signing key before the versionless rejection test.");
      return;
    }
    if (!signed || signed.rollbackVersion === undefined) {
      setError("Create the versioned signed UF2 before the versionless rejection test.");
      return;
    }
    if (!otp?.rollbackRequired) {
      setError("Inspect BOOTSEL OTP and confirm that ROLLBACK_REQUIRED is set before the versionless rejection test.");
      return;
    }
    if (!beginOperation("Versionless-image rejection test")) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.rollbackRequired) throw new Error("ROLLBACK_REQUIRED is not set on this device.");
      const versionless = await sealUf2(signed.original, key);
      await flashUf2(device, versionless.image, (stage, completed, total) => {
        setStatus(`Versionless test: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setRollbackTestStartedContext(workflowContext);
      setRollbackTestPassedContext("");
      setCliStatus(null);
      setSuccess("A signed but versionless image was written. The device must return to BOOTSEL. Restore the versioned image next.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Versionless rejection test failed.");
    } finally {
      endOperation();
    }
  }

  async function restoreAfterRollbackTest(): Promise<void> {
    if (!rollbackTestStarted) {
      setError("Run the versionless-image rejection test before restoring the versioned image.");
      return;
    }
    if (!signed) {
      setError("Create the versioned signed UF2 before restoring it.");
      return;
    }
    if (!beginOperation("Restore versioned image")) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.rollbackRequired) throw new Error("The selected BOOTSEL device does not enforce anti-rollback.");
      await flashUf2(device, signed.image, (stage, completed, total) => {
        setStatus(`Versioned restore: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setRollbackTestPassedContext(workflowContext);
      setCliStatus(null);
      setSuccess("The versionless image was rejected and the versioned signed image was restored. Provisioning is complete.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Versioned image restore failed.");
    } finally {
      endOperation();
    }
  }

  if (!enabled) {
    return (
      <Card as="section" padding="lg" variant="outlined">
        <Switch
          label="Security tools"
          description="Create a per-device signing key, signed UF2, or provision RP2350 secure boot. All irreversible actions are opt-in."
          checked={false}
          onChange={() => setEnabled(true)}
        />
      </Card>
    );
  }

  return (
    <Card as="section" padding="lg" variant="elevated" className="security-tools">
      <Stack gap="lg">
        <Inline justify="between" align="center" gap="md" wrap>
          <Stack gap="sm">
            <Heading level={2} size="xl">Security tools</Heading>
            <Text tone="muted">RP2350 secure-boot signing key.</Text>
            <Text size="sm">
              Before you provision a device, read the RS-Key <Link href={RS_KEY_DOCS.threatModel} external>threat model</Link> to understand what this hardening does and does not protect.
            </Text>
          </Stack>
          <Switch label="Enabled" checked disabled={operationBusy} onChange={(event) => setEnabled(event.target.checked)} />
        </Inline>

        <Alert tone="warning" title="Download the private-key backup">
          Save the SEC1 PEM or 24-word mnemonic before provisioning. The app does not require backup verification, but losing this key after Secure Boot is enabled prevents all future firmware updates.
        </Alert>

        <div className="security-grid">
          <Stack gap="md">
            <Heading level={3} size="lg">1. Signing key</Heading>
            <Text size="sm" tone="muted">
              Generate a new key or import the key that will sign every future firmware update. Download PEM or mnemonic before you continue. Read the <Link href={RS_KEY_DOCS.signingKeys} external>signing-key lifecycle and backup guide</Link> before you fuse its fingerprint.
            </Text>
            {!key ? (
              <Button startIcon={KeyRound} disabled={operationBusy} onClick={generateKey}>Generate per-device key</Button>
            ) : (
              <Stack gap="sm" className="key-result">
                <Text size="sm" tone="muted">Public-key fingerprint</Text>
                <code className="break-code">{key.fingerprint}</code>
                <details>
                  <summary>Show 24-word mnemonic</summary>
                  <Text as="p" className="mnemonic">{key.mnemonic}</Text>
                </details>
                <Inline gap="sm" wrap>
                  <Button variant="secondary" startIcon={Download} onClick={exportPem}>Download SEC1 PEM</Button>
                  <Button variant="secondary" startIcon={Download} onClick={exportMnemonic}>Download mnemonic</Button>
                </Inline>
              </Stack>
            )}
            <TextField
              label="Import key file"
              type="file"
              accept=".pem,.txt,text/plain,application/x-pem-file"
              disabled={operationBusy}
              onChange={(event) => {
                void readKeyFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            {!key && (
              <Textarea
                label="Or paste SEC1 PEM or 24 words"
                value={keyInput}
                rows={4}
                spellCheck={false}
                onChange={(event) => {
                  setKeyInput(event.target.value);
                }}
              />
            )}
            <Button variant="secondary" disabled={!keyInput.trim() || operationBusy} onClick={importOrVerifyKey}>
              {key ? "Check imported key" : "Import key"}
            </Button>
          </Stack>

          <Stack gap="md">
            <Heading level={3} size="lg">2. Create signed UF2</Heading>
            <Text size="sm" tone="muted">Create the recovery image first. The same image is reused throughout provisioning and for every restore test.</Text>
            <Text size="sm" tone="muted">{asset?.name || "Choose a release and variant above."}</Text>
            {asset && !releaseAssetTrusted && (
              <Alert tone="danger" title="Release attestation is not verified">
                Verify the selected GitHub release before you create a signed UF2.
              </Alert>
            )}
            <Switch
              label="Add anti-rollback version"
              checked={useRollback}
              disabled={Boolean(otp?.rollbackRequired)}
              onChange={(event) => {
                setUseRollback(event.target.checked);
              }}
            />
            <Text size="sm" tone="muted">
              Leave this disabled for a standard signed image. Enable it only when you plan to provision anti-rollback. Version 1 is correct for a new device. The <Link href={RS_KEY_DOCS.antiRollback} external>anti-rollback guide</Link> explains the version floor and the 48-version lifetime budget.
            </Text>
            {useRollback && (
              <TextField
                label="Rollback version"
                type="number"
                min={1}
                max={48}
                value={rollbackVersion}
                onChange={(event) => {
                  setRollbackVersion(event.target.value);
                }}
              />
            )}
            <Button
              startIcon={ShieldCheck}
              disabled={!asset || !key || operationBusy || !releaseAssetTrusted}
              loading={busy && status.includes("signed")}
              onClick={createSignedUf2}
            >
              Create signed UF2
            </Button>
          </Stack>
        </div>

        {signed && (
          <Card as="section" padding="md" variant="outlined" className="signed-result">
            <Stack gap="md">
              <Heading level={3} size="lg">Signed UF2</Heading>
              <dl className="artifact-details">
                <div><dt>File</dt><dd className="filename">{signed.filename}</dd></div>
                <div><dt>Size</dt><dd>{formatBytes(signed.bytes.length)}</dd></div>
                <div><dt>SHA-256</dt><dd className="filename">{signed.sha256}</dd></div>
                <div><dt>Signer</dt><dd className="filename">{key?.fingerprint}</dd></div>
                <div><dt>Rollback</dt><dd>{signed.rollbackVersion ?? "not set"}</dd></div>
                {signed.deviceSerial && <div><dt>Target device</dt><dd className="filename">{signed.deviceSerial} at floor {signed.rollbackFloor}</dd></div>}
              </dl>
              <Inline gap="sm" wrap>
                <Button startIcon={Download} disabled={operationBusy} onClick={downloadSignedUf2}>Download signed UF2</Button>
                <Button startIcon={Usb} disabled={!webUsb || operationBusy} onClick={flashSigned}>Connect and flash signed UF2</Button>
                <Button variant="secondary" startIcon={Copy} onClick={() => void navigator.clipboard.writeText(signed.sha256)}>Copy SHA-256</Button>
              </Inline>
              <details className="manual-instructions">
                <summary>Manual flashing instructions</summary>
                <ol className="bootsel-steps">
                  <li>Hold BOOTSEL while connecting the device.</li>
                  <li>Copy <code>{signed.filename}</code> to the <code>RPI-RP2</code> drive and wait for it to disconnect.</li>
                  <li>Or run <code>picotool load -v -x &quot;{signed.filename}&quot;</code>.</li>
                  <li>Return here, inspect BOOTSEL OTP, and continue down the provisioning steps.</li>
                </ol>
                <Alert tone="warning" title="Already sealed">
                  Do not run picotool seal again. The signer must match the device OTP key, and the rollback version must not be below its current floor.
                </Alert>
              </details>
            </Stack>
          </Card>
        )}

        <Stack gap="md">
          <Heading level={3} size="lg">3. Inspect BOOTSEL and check runtime with rsk</Heading>
          <Text size="sm" tone="muted">The browser is used only for BOOTSEL inspection, OTP writes, and flashing. Use the rsk CLI as the primary way to read a running device and to run firmware-side provisioning commands.</Text>
          <Button variant="secondary" startIcon={Usb} disabled={!webUsb || operationBusy} onClick={inspectDevice}>Inspect BOOTSEL OTP</Button>
          {otp && (
            <Alert tone={otp.consistent ? "info" : "danger"} title="BOOTSEL OTP state">
              {stateSummary(otp)}{otp.problems.length ? ` · ${otp.problems.join(" ")}` : ""}
            </Alert>
          )}
          <Alert tone="info" title="rsk is the runtime interface">
            Run rsk from the RS-Key repository while the normal firmware is running. You do not normally need to close this tab. If another program holds the smart-card interface, closing the tab can help as a troubleshooting step.
          </Alert>
          <Text>Run without installation with <Link href="https://docs.astral.sh/uv/getting-started/installation/" external>uv</Link> and Python 3.10 or later:</Text>
          <pre className="cli-command"><code>{`git clone https://github.com/TheMaxMur/RS-Key.git
cd RS-Key
${RSK_COMMANDS.status}`}</code></pre>
          <Inline gap="sm" wrap>
            <Button variant="secondary" startIcon={Copy} onClick={() => void copyCliCommand(RSK_COMMANDS.status, "Runtime status command")}>Copy status command</Button>
            <Link href="https://github.com/TheMaxMur/RS-Key/blob/main/tools/README.md" external>Open the rsk CLI guide</Link>
          </Inline>
          <Text size="sm" tone="muted">For a persistent command, run <code>uv tool install ./tools</code>. On Linux, install PC/SC and start <code>pcscd</code>.</Text>
          <Textarea label="rsk status --json output" value={cliJson} rows={5} onChange={(event) => setCliJson(event.target.value)} />
          <Button variant="secondary" disabled={!cliJson.trim() || operationBusy} onClick={validateCliStatus}>Read rsk status</Button>
          {cliStatus && (
            <Alert tone="success" title="rsk runtime status">
              serial {cliStatus.serial} · secure boot {cliStatus.enabled ? "enabled" : "off"} · boot key {cliStatus.bootKeySlot ?? "none"} · rollback {cliStatus.rollbackRequired ? "required" : "optional"} {cliStatus.rollbackVersion}/{cliStatus.rollbackCapacity}
            </Alert>
          )}
          <Alert tone="warning" title="If secure_boot is null">
            Make sure the normal RS-Key firmware is running, reconnect the device, and run the status command again. If access is still blocked, closing this tab can help, but it is not a normal requirement. Download the signing-key backup first if you choose to close it.
          </Alert>
        </Stack>

        <Stack gap="md" className="provisioning-flow">
          <Heading level={3} size="lg">4. Irreversible production provisioning</Heading>
          <Text tone="muted">
            Continue from top to bottom. Each card tells you whether the device must run the firmware or be connected with BOOTSEL held. Keep the complete RS-Key <Link href={RS_KEY_DOCS.production} external>production setup guide</Link> open as a reference.
          </Text>
          <Alert tone="danger" title="Permanent OTP changes">
            These actions cannot be undone. Browser actions open a confirmation window with the exact token. Runtime actions use the rsk typed confirmation in the terminal. Completed BOOTSEL writes are read back and verified. Read the <Link href={RS_KEY_DOCS.otpFuses} external>RP2350 OTP fuse map</Link> before the first write.
          </Alert>

          <ProvisioningStep
            number={1}
            title="Create the device storage keys"
            mode="BOOTSEL"
            state={inspectedPage58Present || inspectedPage58Locked ? "complete" : inspectedPage58Blank && key ? "ready" : "attention"}
            description="Writes random MKEK and DEVK values to OTP page 58. You do not need to save these values; secure firmware uses them to protect secrets stored in flash."
          >
            <Inline gap="sm" wrap>
              <Button variant="secondary" startIcon={Usb} disabled={!webUsb || operationBusy} onClick={inspectDevice}>Inspect BOOTSEL</Button>
              <Button
                variant="secondary"
                disabled={operationBusy}
                onClick={() => key ? requestIrreversibleAction({
                  token: burnToken,
                  title: "Confirm step 1: Create device storage keys",
                  consequence: "This permanently writes unique MKEK and DEVK values to OTP page 58. The values cannot be erased or replaced.",
                  action: () => void runOtpAction(burnToken, burnPage58Secrets, { page58: "blank" }),
                }) : setError("Generate or import the signing key before provisioning.")}
              >
                Run step 1
              </Button>
            </Inline>
          </ProvisioningStep>

          <ProvisioningStep
            number={2}
            title="Hide page 58 from BOOTSEL"
            mode="running firmware"
            state={inspectedPage58Locked ? "complete" : inspectedPage58Present ? "ready" : "attention"}
            description="Permanently blocks BOOTSEL and non-secure code from reading MKEK and DEVK. Start the normal firmware and run the rsk command below. The CLI asks for typed confirmation and device presence. Then reconnect in BOOTSEL and select Inspect BOOTSEL in the next card."
          >
            <pre className="cli-command"><code>{RSK_COMMANDS.lockPage58}</code></pre>
            <Button variant="secondary" startIcon={Copy} onClick={() => void copyCliCommand(RSK_COMMANDS.lockPage58, "Step 2: lock OTP page 58")}>
              Copy step 2 command
            </Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={3}
            title="Trust this firmware signing key"
            mode="BOOTSEL"
            state={hasTrustedBootKey ? "complete" : inspectedPage58Locked && key ? "ready" : "attention"}
            description="Writes only the SHA-256 fingerprint of the public signing key to OTP. The private key stays in your backup. Signature enforcement is still off after this step."
          >
            <Inline gap="sm" wrap>
              <Button variant="secondary" startIcon={Usb} disabled={!webUsb || operationBusy} onClick={inspectDevice}>Inspect BOOTSEL</Button>
              <Button
                variant="secondary"
                disabled={operationBusy}
                onClick={() => key ? requestIrreversibleAction({
                  token: "LOAD-BOOTKEY",
                  title: "Confirm step 3: Trust the signing key",
                  consequence: "This permanently stores the public signing-key fingerprint in an OTP key slot. The slot cannot be erased or changed.",
                  action: () => void runOtpAction("LOAD-BOOTKEY", (device) => loadBootKeyFingerprint(device, key.fingerprint), { page58: "locked" }),
                }) : setError("Import the Secure Boot signing key before loading its fingerprint.")}
              >
                Run step 3
              </Button>
            </Inline>
          </ProvisioningStep>

          <ProvisioningStep
            number={4}
            title="Disable hardware debug"
            mode="BOOTSEL"
            state={hardened ? "complete" : hasTrustedBootKey && key ? "ready" : "attention"}
            description="Permanently disables SWD debug and enables the RP2350 glitch detector. This does not enable signature enforcement, so continue directly to step 5 in the same BOOTSEL session."
          >
            <Button
              variant="secondary"
              disabled={operationBusy}
              onClick={() => key ? requestIrreversibleAction({
                token: "HARDEN-SECURE-BOOT",
                title: "Confirm step 4: Disable hardware debug",
                consequence: "This permanently disables SWD hardware debug and enables the glitch detector. SWD recovery will no longer be available.",
                action: () => void runOtpAction("HARDEN-SECURE-BOOT", (device) => hardenSecureBoot(device, key.fingerprint)),
              }) : setError("Import the Secure Boot signing key before hardening.")}
            >
              Run step 4
            </Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={5}
            title="Enforce signed firmware"
            mode="BOOTSEL"
            state={otp?.secureBootEnabled ? "complete" : hardened && signed ? "ready" : "attention"}
            description="Sets SECURE_BOOT_ENABLE. From this point, the RP2350 rejects firmware that is not signed by the trusted key. Make sure the signed recovery UF2 was created before you continue."
          >
            <Button
              variant="secondary"
              disabled={operationBusy}
              onClick={() => key ? requestIrreversibleAction({
                token: "ENABLE-SECURE-BOOT",
                title: "Confirm step 5: Enforce signed firmware",
                consequence: "This permanently enables Secure Boot. The device will reject firmware that is unsigned or signed by a different key.",
                action: () => void runOtpAction("ENABLE-SECURE-BOOT", (device) => enableSecureBoot(device, key.fingerprint), { signedImage: true, bootAfter: true }),
              }) : setError("Import the Secure Boot signing key before enabling enforcement.")}
            >
              Run step 5
            </Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={6}
            title="Prove that unsigned firmware is rejected"
            mode="BOOTSEL"
            state={negativeTestStarted ? "complete" : otp?.secureBootEnabled && signed ? "ready" : "attention"}
            description="First boot the signed image once after step 5. Then reconnect with BOOTSEL and run this test. It temporarily writes the original unsigned image; enforced Secure Boot must reject it and return to BOOTSEL. Progress is shown in the active toast and console."
          >
            <Button variant="secondary" loading={busy && activeOperation === "Unsigned-image rejection test"} disabled={operationBusy} onClick={startNegativeTest}>Run step 6</Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={7}
            title="Restore the signed firmware"
            mode="BOOTSEL"
            state={negativeTestPassed ? "complete" : negativeTestStarted ? "ready" : "attention"}
            description="Restores the signed recovery image after the unsigned rejection test and verifies every written byte. No new key or signed image is required."
          >
            <Button variant="secondary" loading={busy && activeOperation === "Restore signed image"} disabled={operationBusy} onClick={restoreAfterNegativeTest}>Run step 7</Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={8}
            title="Finalize the Secure Boot key policy"
            mode="BOOTSEL"
            state={otp?.pagesLocked ? "complete" : negativeTestPassed && key ? "ready" : "attention"}
            description="Revokes unused boot-key slots and makes OTP pages 1 and 2 read-only to BOOTSEL. Future firmware must use the current signing key; key rotation is no longer possible."
          >
            <Button
              variant="secondary"
              disabled={operationBusy}
              onClick={() => key ? requestIrreversibleAction({
                token: "LOCK-SECURE-BOOT",
                title: "Confirm step 8: Finalize the Secure Boot key policy",
                consequence: "This permanently revokes unused key slots and locks OTP pages 1 and 2 against BOOTSEL writes. You cannot rotate the signing key after this action.",
                action: () => void runOtpAction("LOCK-SECURE-BOOT", (device) => lockSecureBootPages(device, key.fingerprint), { signedImage: true, negativeTest: true }),
              }) : setError("Import the Secure Boot signing key before the final lock.")}
            >
              Run step 8
            </Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={9}
            title="Require rollback versions"
            mode="running firmware"
            state={otp?.rollbackRequired || cliStatus?.rollbackRequired ? "complete" : signed?.rollbackVersion !== undefined ? "ready" : "attention"}
            description="Permanently rejects signed images that have no rollback version or have a version below the OTP floor. Boot the versioned signed firmware and verify its version with rsk status first. The CLI then applies the fuse with typed confirmation and device presence."
          >
            <pre className="cli-command"><code>{RSK_COMMANDS.requireRollback}</code></pre>
            <Text size="sm">Review the <Link href={RS_KEY_DOCS.antiRollback} external>anti-rollback policy and recovery limits</Link> before you make rollback versions mandatory.</Text>
            <Text size="sm">After the command succeeds, run <code>{RSK_COMMANDS.status}</code> again and verify that rollback is required. Then reconnect in BOOTSEL for step 10.</Text>
            <Button variant="secondary" startIcon={Copy} onClick={() => void copyCliCommand(RSK_COMMANDS.requireRollback, "Step 9: require rollback versions")}>
              Copy step 9 command
            </Button>
          </ProvisioningStep>

          <ProvisioningStep
            number={10}
            title="Prove that versionless firmware is rejected"
            mode="BOOTSEL"
            state={rollbackTestStarted ? "complete" : otp?.rollbackRequired && signed?.rollbackVersion !== undefined && key ? "ready" : "attention"}
            description="Creates a temporary image signed by the correct key but without a rollback version. The device must reject it and return to BOOTSEL. Progress is shown continuously."
          >
            <Inline gap="sm" wrap>
              <Button variant="secondary" startIcon={Usb} disabled={!webUsb || operationBusy} onClick={inspectDevice}>Inspect BOOTSEL</Button>
              <Button variant="secondary" loading={busy && activeOperation === "Versionless-image rejection test"} disabled={operationBusy} onClick={startVersionlessRollbackTest}>Run step 10</Button>
            </Inline>
          </ProvisioningStep>

          <ProvisioningStep
            number={11}
            title="Restore the versioned firmware"
            mode="BOOTSEL"
            state={rollbackTestPassed ? "complete" : rollbackTestStarted ? "ready" : "attention"}
            description="Restores and verifies the working signed image with its rollback version. Provisioning is complete when this step succeeds."
          >
            <Button variant="secondary" loading={busy && activeOperation === "Restore versioned image"} disabled={operationBusy} onClick={restoreAfterRollbackTest}>Run step 11</Button>
          </ProvisioningStep>
        </Stack>

        <Dialog
          open={Boolean(pendingConfirmation)}
          onOpenChange={(open) => {
            if (!open) closeConfirmation();
          }}
          title={pendingConfirmation?.title ?? "Confirm permanent action"}
          description="Review the result, copy the token, and type it exactly to continue."
          closeLabel="Close confirmation"
          footer={(
            <Inline gap="sm" justify="end" wrap>
              <Button variant="secondary" onClick={closeConfirmation}>Cancel</Button>
              <Button
                variant="danger"
                disabled={!pendingConfirmation || confirmation !== pendingConfirmation.token}
                onClick={confirmIrreversibleAction}
              >
                Confirm permanent action
              </Button>
            </Inline>
          )}
        >
          {pendingConfirmation && (
            <Stack gap="md">
              <Alert tone="danger" title="Permanent result">
                {pendingConfirmation.consequence} There is no undo.
              </Alert>
              <Stack gap="sm">
                <Text size="sm" tone="muted">Confirmation token</Text>
                <Inline gap="sm" align="center" wrap>
                  <code className="confirmation-token">{pendingConfirmation.token}</code>
                  <Button variant="secondary" startIcon={Copy} onClick={() => void copyConfirmationToken()}>
                    Copy token
                  </Button>
                </Inline>
              </Stack>
              <TextField
                label="Type the confirmation token"
                value={confirmation}
                spellCheck={false}
                autoComplete="off"
                error={confirmation && confirmation !== pendingConfirmation.token ? "The token does not match." : undefined}
                onChange={(event) => setConfirmation(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && confirmation === pendingConfirmation.token) confirmIrreversibleAction();
                }}
              />
            </Stack>
          )}
        </Dialog>

      </Stack>
    </Card>
  );
}
