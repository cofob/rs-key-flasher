"use client";

import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Heading,
  Inline,
  Progress,
  Stack,
  Switch,
  Text,
  Textarea,
  TextField,
} from "@cofob/design-system-react/static";
import { Copy, Download, KeyRound, ShieldCheck, Usb } from "lucide-react";
import { downloadVerifiedAsset, sha256Hex } from "../lib/assets";
import {
  Ccid,
  parseRskStatusJson,
  readRuntimeSecureBootStatus,
  requestRuntimeDevice,
  type RuntimeSecureBootStatus,
} from "../lib/ccid";
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
  webUsb: boolean;
  rawFlashEpoch: number;
  externalBusy: boolean;
  operationLockRef: MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
}

const STAGE_LABELS: Record<FlashStage, string> = {
  connect: "Connecting to picoboot…",
  erase: "Erasing firmware sectors…",
  write: "Writing signed firmware…",
  verify: "Reading back and verifying…",
  reboot: "Rebooting RS-Key…",
};

function flashPercent(stage: FlashStage, completed: number, total: number): number {
  const ratio = total ? completed / total : 0;
  if (stage === "connect") return ratio * 5;
  if (stage === "erase") return 5 + ratio * 20;
  if (stage === "write") return 25 + ratio * 35;
  if (stage === "verify") return 60 + ratio * 35;
  return 95 + ratio * 5;
}

function normalizeSerial(value: string): string {
  const normalized = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  return normalized.length >= 16 ? normalized.slice(-16) : "";
}

function serialsMatch(left: string, right: string): boolean {
  const a = normalizeSerial(left);
  const b = normalizeSerial(right);
  return Boolean(a && b && a === b);
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

export function SecurityTools({ asset, webUsb, rawFlashEpoch, externalBusy, operationLockRef, onBusyChange }: SecurityToolsProps) {
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState<SecureBootKey | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyInputSource, setKeyInputSource] = useState<"file" | "paste" | null>(null);
  const [backupExported, setBackupExported] = useState(false);
  const [backupVerified, setBackupVerified] = useState(false);
  const [useRollback, setUseRollback] = useState(false);
  const [rollbackVersion, setRollbackVersion] = useState("1");
  const [raiseRollback, setRaiseRollback] = useState(false);
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const [signedResult, setSignedResult] = useState<SignedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [otp, setOtp] = useState<SecureBootOtpState | null>(null);
  const [boundSerial, setBoundSerial] = useState("");
  const [runtimeProof, setRuntimeProof] = useState<RuntimeSecureBootStatus | null>(null);
  const [proofContext, setProofContext] = useState("");
  const [bootCandidateContext, setBootCandidateContext] = useState("");
  const [bootCandidateSerial, setBootCandidateSerial] = useState("");
  const [cliJson, setCliJson] = useState("");
  const [showProvisioning, setShowProvisioning] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [negativeTestStartedContext, setNegativeTestStartedContext] = useState("");
  const [negativeTestPassedContext, setNegativeTestPassedContext] = useState("");
  const [rollbackTestStartedContext, setRollbackTestStartedContext] = useState("");
  const [rollbackTestPassedContext, setRollbackTestPassedContext] = useState("");
  const operationBusy = busy || externalBusy;

  useEffect(() => () => { if (key) clearSecureBootKey(key); }, [key]);

  const signingContext = `${asset?.id || "none"}:${key?.fingerprint || "none"}:${useRollback ? `${rollbackVersion}:${otp?.serial || "uninspected"}:${otp?.bootVersion ?? "unknown"}` : "none"}`;
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

  const proofMatchesDevice = useMemo(
    () => Boolean(
      runtimeProof
      && boundSerial
      && signed
      && proofContext === workflowContext
      && bootCandidateContext === workflowContext
      && serialsMatch(runtimeProof.serial, boundSerial)
      && serialsMatch(runtimeProof.serial, bootCandidateSerial),
    ),
    [runtimeProof, boundSerial, signed, proofContext, workflowContext, bootCandidateContext, bootCandidateSerial],
  );

  function beginOperation(): boolean {
    if (operationLockRef.current) return false;
    operationLockRef.current = true;
    setBusy(true);
    onBusyChange(true);
    return true;
  }

  function endOperation(): void {
    setBusy(false);
    onBusyChange(false);
    operationLockRef.current = false;
  }

  function acceptOtpState(state: SecureBootOtpState): void {
    setOtp(state);
    setRaiseRollback(false);
    setRollbackConfirmation("");
    if (state.rollbackRequired) {
      setUseRollback(true);
      setRollbackVersion(String(Math.max(1, state.bootVersion)));
    }
  }

  function replaceKey(next: SecureBootKey): void {
    if (key) clearSecureBootKey(key);
    setKey(next);
    setSignedResult(null);
    setRuntimeProof(null);
    setBootCandidateContext("");
    setBootCandidateSerial("");
    setBackupExported(false);
    setBackupVerified(false);
    setKeyInput("");
    setKeyInputSource(null);
    setError("");
  }

  async function generateKey(): Promise<void> {
    if (!beginOperation()) return;
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
    if (!beginOperation()) return;
    setError("");
    try {
      const imported = await importKey(keyInput);
      if (key && imported.fingerprint !== key.fingerprint) {
        clearSecureBootKey(imported);
        throw new Error("This backup belongs to a different signing key.");
      }
      if (key) {
        if (!backupExported || keyInputSource !== "file") {
          clearSecureBootKey(imported);
          throw new Error("Download the PEM or mnemonic, then select that backup file to verify it.");
        }
        clearSecureBootKey(key);
        setKey(imported);
        setSignedResult(null);
        setRuntimeProof(null);
        setBootCandidateContext("");
        setBootCandidateSerial("");
        setBackupVerified(true);
        setKeyInput("");
        setKeyInputSource(null);
        setSuccess("The downloaded key backup was verified.");
      } else {
        replaceKey(imported);
        setSuccess("Signing key imported for an update. Export and re-import it before any OTP write.");
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
    setKeyInputSource("file");
  }

  function exportPem(): void {
    if (!key) return;
    downloadBlob(`rs-key-${key.fingerprint.slice(0, 8)}-secure-boot.pem`, key.pem, "application/x-pem-file");
    setBackupExported(true);
    setBackupVerified(false);
    setKeyInput("");
    setKeyInputSource(null);
  }

  function exportMnemonic(): void {
    if (!key) return;
    downloadBlob(`rs-key-${key.fingerprint.slice(0, 8)}-secure-boot.mnemonic.txt`, `${key.mnemonic}\n`, "text/plain");
    setBackupExported(true);
    setBackupVerified(false);
    setKeyInput("");
    setKeyInputSource(null);
  }

  async function createSignedUf2(): Promise<void> {
    if (!asset || !key) return;
    if (!beginOperation()) return;
    setError("");
    setSuccess("");
    setProgress(1);
    try {
      setStatus("Downloading and checking original firmware…");
      const original = await downloadVerifiedAsset(asset, (value) => setProgress(1 + value * 39));
      const version = useRollback ? Number(rollbackVersion) : undefined;
      if (version !== undefined) {
        if (!otp || !otp.consistent || !boundSerial || !serialsMatch(boundSerial, otp.serial)) {
          throw new Error("Inspect and bind the target BOOTSEL device before creating a versioned UF2.");
        }
        if (version < Math.max(1, otp.bootVersion) || version > otp.bootVersion + 1) {
          throw new Error(`For this device use rollback version ${Math.max(1, otp.bootVersion)} or ${otp.bootVersion + 1}.`);
        }
        if (version === otp.bootVersion + 1) {
          const token = `RAISE-ROLLBACK-${otp.bootVersion}-TO-${otp.bootVersion + 1}`;
          if (!raiseRollback || rollbackConfirmation !== token) {
            throw new Error(`Confirm the one-step rollback-floor increase and type ${token} exactly.`);
          }
          if (!backupExported || !backupVerified) {
            throw new Error("Export and re-import the private-key backup before creating an image that raises the rollback floor.");
          }
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
      setSuccess(`${filename} was sealed and its signature was verified in this browser.`);
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
    if (runtimeProof && !serialsMatch(runtimeProof.serial, state.serial)) throw new Error("The boot proof belongs to a different device.");
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
      if (signed.rollbackVersion === state.bootVersion + 1) {
        const token = `RAISE-ROLLBACK-${state.bootVersion}-TO-${state.bootVersion + 1}`;
        if (!raiseRollback || rollbackConfirmation !== token) throw new Error(`Confirm the one-step rollback-floor increase and type ${token} exactly.`);
        if (!backupExported || !backupVerified) throw new Error("Export and re-import the private-key backup before raising the rollback floor.");
      }
    } else if (state.rollbackRequired) {
      throw new Error(`This device requires rollback version ${state.bootVersion} or later.`);
    }
  }

  function downloadSignedUf2(): void {
    if (!signed || operationLockRef.current) return;
    if (signed.rollbackVersion !== undefined && signed.rollbackFloor !== undefined && signed.rollbackVersion === signed.rollbackFloor + 1) {
      const token = `RAISE-ROLLBACK-${signed.rollbackFloor}-TO-${signed.rollbackVersion}`;
      if (!raiseRollback || rollbackConfirmation !== token || !backupExported || !backupVerified) {
        setError(`Re-import the backup and type ${token} before downloading this one-step rollback image.`);
        return;
      }
      setBackupVerified(false);
      setRaiseRollback(false);
      setRollbackConfirmation("");
    }
    downloadBlob(signed.filename, signed.bytes.slice().buffer as ArrayBuffer, "application/octet-stream");
    setBootCandidateContext(workflowContext);
    setBootCandidateSerial(boundSerial);
  }

  function validateRuntimeProof(status: RuntimeSecureBootStatus): void {
    if (!signed) throw new Error("Create and flash the signed UF2 before obtaining provisioning proof.");
    if (signed.rollbackVersion !== undefined && status.rollbackVersion !== signed.rollbackVersion) {
      throw new Error(`The running device rollback version ${status.rollbackVersion} does not match signed UF2 version ${signed.rollbackVersion}.`);
    }
    if (signed.rollbackVersion === undefined && status.rollbackRequired) {
      throw new Error("The running device requires a versioned signed UF2.");
    }
  }

  function acceptBootCandidateSerial(serial: string): boolean {
    if (bootCandidateContext !== workflowContext) return false;
    if (bootCandidateSerial) return serialsMatch(bootCandidateSerial, serial);
    if (boundSerial && !serialsMatch(boundSerial, serial)) return false;
    setBootCandidateSerial(serial);
    return true;
  }

  async function inspectDevice(): Promise<void> {
    if (!beginOperation()) return;
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
    if (!beginOperation()) return;
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
        setBackupVerified(false);
        setRaiseRollback(false);
        setRollbackConfirmation("");
      }
      setBoundSerial(state.serial);
      acceptOtpState(state);
      await flashUf2(device, signed.image, (stage, completed, total) => {
        setStatus(STAGE_LABELS[stage]);
        setProgress(flashPercent(stage, completed, total));
      });
      setBootCandidateContext(workflowContext);
      setBootCandidateSerial(state.serial);
      setRuntimeProof(null);
      setProofContext("");
      setStatus("Signed flash verified");
      setProgress(100);
      setSuccess("The signed image was written, read back, verified, and started. Obtain runtime boot proof before any OTP action.");
    } catch (reason) {
      setStatus("Stopped");
      setError(reason instanceof Error ? reason.message : "Signed flashing failed.");
    } finally {
      endOperation();
    }
  }

  async function obtainRuntimeProof(): Promise<void> {
    if (!beginOperation()) return;
    setError("");
    try {
      const status = await readRuntimeSecureBootStatus(await requestRuntimeDevice());
      if (boundSerial && !serialsMatch(boundSerial, status.serial)) throw new Error("The runtime device is not the RP2350 bound to this session.");
      setBoundSerial((current) => current || status.serial);
      setRuntimeProof(status);
      if (!acceptBootCandidateSerial(status.serial)) {
        setProofContext("");
        throw new Error("Flash the current signed UF2, or download it for manual flashing, before obtaining provisioning proof.");
      }
      validateRuntimeProof(status);
      setProofContext(workflowContext);
      setSuccess(`Runtime boot proven for device ${status.serial}.`);
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : "Runtime proof failed."} Use the rsk CLI fallback below.`);
    } finally {
      endOperation();
    }
  }

  function validateCliProof(): void {
    try {
      const proof = parseRskStatusJson(cliJson);
      if (boundSerial && !serialsMatch(boundSerial, proof.serial)) throw new Error("The CLI status belongs to a different device.");
      setBoundSerial((current) => current || proof.serial);
      setRuntimeProof(proof);
      if (!acceptBootCandidateSerial(proof.serial)) {
        setProofContext("");
        throw new Error("Flash the current signed UF2, or download it for manual flashing, before validating provisioning proof.");
      }
      validateRuntimeProof(proof);
      setProofContext(workflowContext);
      setError("");
      setSuccess(`CLI boot proof accepted for device ${proof.serial}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "CLI proof validation failed.");
    }
  }

  async function runOtpAction(
    token: string,
    action: (device: USBDevice) => Promise<SecureBootOtpState | { state: SecureBootOtpState }>,
    options: { proof?: boolean; backup?: boolean; signedImage?: boolean; negativeTest?: boolean; page58?: "blank" | "present" | "locked" } = {},
  ): Promise<void> {
    if (options.page58 && (!otp || !otp.consistent || otp.page58 !== options.page58 || !serialsMatch(otp.serial, boundSerial))) {
      setError(`Inspect and bind the target BOOTSEL device with page 58 ${options.page58} before this action.`);
      return;
    }
    if (confirmation !== token) {
      setError(`Type ${token} exactly before this irreversible action.`);
      return;
    }
    if (options.proof && !proofMatchesDevice) {
      setError("A matching runtime boot proof is required before this action.");
      return;
    }
    if (options.backup && (!backupExported || !backupVerified)) {
      setError("Export and re-import the private-key backup before this action.");
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
    if (!beginOperation()) return;
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
      if (options.backup) setBackupVerified(false);
      setConfirmation("");
      const result = await action(device);
      const state = "state" in result ? result.state : result;
      acceptOtpState(state);
      setRuntimeProof(null);
      setProofContext("");
      setSuccess(`${token} completed and verified. Reboot the signed image and obtain a new boot proof.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${token} failed.`);
    } finally {
      endOperation();
    }
  }

  async function runRuntimeFuse(kind: "page58" | "rollback", token: string): Promise<void> {
    if (confirmation !== token) {
      setError(`Type ${token} exactly before this irreversible action.`);
      return;
    }
    if (!proofMatchesDevice) {
      setError("A matching runtime boot proof is required before this action.");
      return;
    }
    if (!backupExported || !backupVerified) {
      setError("Export and re-import the private-key backup before this action.");
      return;
    }
    if (kind === "page58" && (!otp || !otp.consistent || otp.page58 !== "present" || !serialsMatch(otp.serial, boundSerial))) {
      setError("Inspect the same BOOTSEL device and verify its complete page-58 key and chaff layout before locking it.");
      return;
    }
    if (!beginOperation()) return;
    setError("");
    try {
      const device = await requestRuntimeDevice();
      const connection = new Ccid(device);
      await connection.open();
      try {
        const status = await connection.readRuntimeStatus();
        if (!serialsMatch(boundSerial, status.serial)) throw new Error("A different runtime device was selected.");
        validateRuntimeProof(status);
        if (kind === "rollback") {
          if (!signed?.rollbackVersion || status.rollbackVersion !== signed.rollbackVersion) {
            throw new Error("Boot the versioned signed image before setting ROLLBACK_REQUIRED.");
          }
          setBackupVerified(false);
          setConfirmation("");
          await connection.requireRollback();
          const verified = await connection.readRuntimeStatus();
          if (!verified.rollbackRequired) throw new Error("ROLLBACK_REQUIRED did not verify after the runtime write.");
        } else {
          setBackupVerified(false);
          setConfirmation("");
          await connection.lockPage58();
        }
      } finally {
        await connection.close();
      }
      setOtp(null);
      setRuntimeProof(null);
      setProofContext("");
      setSuccess(`${token} completed. Reconnect in BOOTSEL and inspect OTP to verify the new state.`);
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : `${token} failed.`} CLI fallback: ${kind === "page58" ? "rsk otp lock-page58" : "rsk otp rollback-require"}`);
    } finally {
      endOperation();
    }
  }

  async function rebootRuntime(bootsel: boolean): Promise<void> {
    if (!beginOperation()) return;
    setError("");
    setSuccess("");
    try {
      const device = await requestRuntimeDevice();
      const connection = new Ccid(device);
      await connection.open();
      try {
        const runtime = await connection.readRuntimeStatus();
        if (boundSerial && !serialsMatch(boundSerial, runtime.serial)) throw new Error("A different runtime device was selected.");
        setBoundSerial((current) => current || runtime.serial);
        await connection.reboot(bootsel);
      } finally {
        await connection.close();
      }
      setRuntimeProof(null);
      setProofContext("");
      setSuccess(bootsel ? "Reboot to BOOTSEL sent after device confirmation." : "Application reboot sent.");
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : "Runtime reboot failed."} CLI fallback: rsk reboot ${bootsel ? "bootsel" : "app"}`);
    } finally {
      endOperation();
    }
  }

  async function startNegativeTest(): Promise<void> {
    if (!signed || !otp?.secureBootEnabled || !proofMatchesDevice) {
      setError("Enabled secure boot, a signed image, and matching boot proof are required for the rejection test.");
      return;
    }
    if (!beginOperation()) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.secureBootEnabled) throw new Error("Secure boot is not enabled.");
      setBootCandidateContext("");
      setBootCandidateSerial("");
      await flashUf2(device, parseUf2(signed.original), (stage, completed, total) => {
        setStatus(`Unsigned test: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setNegativeTestStartedContext(workflowContext);
      setNegativeTestPassedContext("");
      setRuntimeProof(null);
      setProofContext("");
      setSuccess("Unsigned image written. A working secure-boot device must return to BOOTSEL. Use Restore signed image next.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unsigned rejection test failed.");
    } finally {
      endOperation();
    }
  }

  async function restoreAfterNegativeTest(): Promise<void> {
    if (!negativeTestStarted || !signed) return;
    if (!beginOperation()) return;
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
      setBootCandidateContext(workflowContext);
      setBootCandidateSerial(state.serial);
      setNegativeTestPassedContext(workflowContext);
      setRuntimeProof(null);
      setProofContext("");
      setSuccess("The unsigned image was rejected and the signed image was restored. Obtain a new runtime proof before full lock.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Signed image restore failed.");
    } finally {
      endOperation();
    }
  }

  async function startVersionlessRollbackTest(): Promise<void> {
    if (!signed || !key || !otp?.rollbackRequired || !proofMatchesDevice) {
      setError("A versioned signed image, enforced anti-rollback, and matching boot proof are required.");
      return;
    }
    if (!beginOperation()) return;
    setError("");
    try {
      const device = await requestPicobootDevice();
      const state = await readSecureBootOtpState(device);
      validateSignedArtifact(state);
      if (!state.rollbackRequired) throw new Error("ROLLBACK_REQUIRED is not set on this device.");
      const versionless = await sealUf2(signed.original, key);
      setBootCandidateContext("");
      setBootCandidateSerial("");
      await flashUf2(device, versionless.image, (stage, completed, total) => {
        setStatus(`Versionless test: ${STAGE_LABELS[stage]}`);
        setProgress(flashPercent(stage, completed, total));
      });
      setRollbackTestStartedContext(workflowContext);
      setRollbackTestPassedContext("");
      setRuntimeProof(null);
      setProofContext("");
      setSuccess("A signed but versionless image was written. The device must return to BOOTSEL. Restore the versioned image next.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Versionless rejection test failed.");
    } finally {
      endOperation();
    }
  }

  async function restoreAfterRollbackTest(): Promise<void> {
    if (!rollbackTestStarted || !signed) return;
    if (!beginOperation()) return;
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
      setBootCandidateContext(workflowContext);
      setBootCandidateSerial(state.serial);
      setRollbackTestPassedContext(workflowContext);
      setRuntimeProof(null);
      setProofContext("");
      setSuccess("The versionless image was rejected and the versioned signed image was restored. Obtain a fresh runtime proof.");
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
            <Text tone="muted">RP2350 secure-boot signing key. This is not an X.509 CA.</Text>
          </Stack>
          <Switch label="Enabled" checked disabled={operationBusy} onChange={(event) => setEnabled(event.target.checked)} />
        </Inline>

        <Alert tone="warning" title="One key per device">
          The private key never leaves this browser unless you download it. If you lose it after secure boot is enabled, that device cannot receive another firmware update.
        </Alert>

        <div className="security-grid">
          <Stack gap="md">
            <Heading level={3} size="lg">1. Signing key</Heading>
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
                  setKeyInputSource("paste");
                }}
              />
            )}
            <Button variant="secondary" disabled={!keyInput.trim() || operationBusy} onClick={importOrVerifyKey}>
              {key ? "Verify backup" : "Import key"}
            </Button>
            {backupExported && !backupVerified && (
              <Alert tone="warning" title="Backup not verified">Select the downloaded PEM or mnemonic file to verify it before provisioning OTP.</Alert>
            )}
            {backupVerified && <Alert tone="success" title="Backup verified">The exported private key matches this session.</Alert>}
          </Stack>

          <Stack gap="md">
            <Heading level={3} size="lg">2. Create signed UF2</Heading>
            <Text size="sm" tone="muted">{asset?.name || "Choose a release and variant above."}</Text>
            <Switch
              label="Add anti-rollback version"
              checked={useRollback}
              disabled={Boolean(otp?.rollbackRequired)}
              onChange={(event) => {
                setUseRollback(event.target.checked);
                setRaiseRollback(false);
                setRollbackConfirmation("");
              }}
            />
            {useRollback && (
              <TextField
                label="Rollback version"
                type="number"
                min={1}
                max={48}
                value={rollbackVersion}
                onChange={(event) => {
                  setRollbackVersion(event.target.value);
                  setRaiseRollback(false);
                  setRollbackConfirmation("");
                }}
              />
            )}
            {useRollback && otp && Number(rollbackVersion) === otp.bootVersion + 1 && (
              <Checkbox
                label={`Raise this device rollback floor from ${otp.bootVersion} to ${otp.bootVersion + 1}`}
                description="This one-way change rejects every older firmware version."
                checked={raiseRollback}
                onChange={(event) => {
                  setRaiseRollback(event.target.checked);
                  setRollbackConfirmation("");
                }}
              />
            )}
            {useRollback && otp && Number(rollbackVersion) === otp.bootVersion + 1 && raiseRollback && (
              <TextField
                label={`Type RAISE-ROLLBACK-${otp.bootVersion}-TO-${otp.bootVersion + 1}`}
                value={rollbackConfirmation}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setRollbackConfirmation(event.target.value)}
              />
            )}
            <Button
              startIcon={ShieldCheck}
              disabled={!asset || !key || operationBusy}
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
                  <li>Return here and obtain runtime boot proof before any OTP action.</li>
                </ol>
                <Alert tone="warning" title="Already sealed">
                  Do not run picotool seal again. The signer must match the device OTP key, and the rollback version must not be below its current floor.
                </Alert>
              </details>
            </Stack>
          </Card>
        )}

        <Stack gap="md">
          <Heading level={3} size="lg">3. Device state and boot proof</Heading>
          <Inline gap="sm" wrap>
            <Button variant="secondary" startIcon={Usb} disabled={!webUsb || operationBusy} onClick={inspectDevice}>Inspect BOOTSEL OTP</Button>
            <Button variant="secondary" startIcon={ShieldCheck} disabled={!webUsb || operationBusy} onClick={obtainRuntimeProof}>Read runtime proof</Button>
            <Button variant="secondary" disabled={!webUsb || operationBusy} onClick={() => void rebootRuntime(false)}>Reboot app</Button>
            <Button variant="secondary" disabled={!webUsb || operationBusy} onClick={() => void rebootRuntime(true)}>Reboot to BOOTSEL</Button>
          </Inline>
          {otp && (
            <Alert tone={otp.consistent ? "info" : "danger"} title="BOOTSEL OTP state">
              {stateSummary(otp)}{otp.problems.length ? ` · ${otp.problems.join(" ")}` : ""}
            </Alert>
          )}
          {runtimeProof && (
            <Alert tone={proofMatchesDevice ? "success" : "danger"} title="Runtime boot proof">
              {runtimeProof.source} · serial {runtimeProof.serial} · secure boot {runtimeProof.enabled ? "enabled" : "off"} · rollback {runtimeProof.rollbackRequired ? "required" : "optional"} {runtimeProof.rollbackVersion}/{runtimeProof.rollbackCapacity}
            </Alert>
          )}
          <details>
            <summary>rsk CLI fallback</summary>
            <Stack gap="sm" className="details-content">
              <Text>Run <code>rsk status --json</code>, then paste its complete output:</Text>
              <Textarea label="rsk status JSON" value={cliJson} rows={5} onChange={(event) => setCliJson(event.target.value)} />
              <Button variant="secondary" disabled={!cliJson.trim() || operationBusy} onClick={validateCliProof}>Validate CLI proof</Button>
              <Text size="sm" tone="muted">Runtime fallbacks: <code>rsk reboot app</code>, <code>rsk reboot bootsel</code>, <code>rsk otp lock-page58</code>, and <code>rsk otp rollback-require</code>. Reconnect in BOOTSEL and inspect OTP after either fuse command.</Text>
            </Stack>
          </details>
        </Stack>

        <Stack gap="md">
          <Checkbox
            label="Show irreversible production provisioning"
            description="Each action writes one-way RP2350 OTP fuses and needs its own exact token."
            checked={showProvisioning}
            onChange={(event) => setShowProvisioning(event.target.checked)}
          />
          {showProvisioning && (
            <Card as="section" padding="md" variant="outlined" className="provisioning-actions">
              <Stack gap="md">
                <Alert tone="danger" title="Irreversible actions">Use one RP2350 device, one signing key, and follow the stages in order. The app refuses inconsistent or foreign OTP state.</Alert>
                <TextField
                  label="Confirmation token"
                  value={confirmation}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <div className="action-list">
                  <Button variant="secondary" disabled={operationBusy || !key || !inspectedPage58Blank} onClick={() => void runOtpAction(burnToken, burnPage58Secrets, { backup: true, page58: "blank" })}>{burnToken} · create MKEK + DEVK</Button>
                  <Button variant="secondary" disabled={operationBusy || !inspectedPage58Present || !proofMatchesDevice} onClick={() => void runRuntimeFuse("page58", "LOCK-PAGE58")}>LOCK-PAGE58 · runtime hard lock</Button>
                  <Button variant="secondary" disabled={operationBusy || !key || !inspectedPage58Locked} onClick={() => key && void runOtpAction("LOAD-BOOTKEY", (device) => loadBootKeyFingerprint(device, key.fingerprint), { proof: true, backup: true, signedImage: true, page58: "locked" })}>LOAD-BOOTKEY · trust this signer</Button>
                  <Button variant="secondary" disabled={operationBusy || !key} onClick={() => key && void runOtpAction("HARDEN-SECURE-BOOT", (device) => hardenSecureBoot(device, key.fingerprint), { proof: true, backup: true, signedImage: true })}>HARDEN-SECURE-BOOT · disable debug</Button>
                  <Button variant="secondary" disabled={operationBusy || !key} onClick={() => key && void runOtpAction("ENABLE-SECURE-BOOT", (device) => enableSecureBoot(device, key.fingerprint), { proof: true, backup: true, signedImage: true })}>ENABLE-SECURE-BOOT · enforce signatures</Button>
                  <Button variant="secondary" disabled={operationBusy} onClick={startNegativeTest}>Flash unsigned rejection test</Button>
                  <Button variant="secondary" disabled={operationBusy || !negativeTestStarted} onClick={restoreAfterNegativeTest}>Restore signed image after rejection</Button>
                  <Button variant="secondary" disabled={operationBusy || !key} onClick={() => key && void runOtpAction("LOCK-SECURE-BOOT", (device) => lockSecureBootPages(device, key.fingerprint), { proof: true, backup: true, signedImage: true, negativeTest: true })}>LOCK-SECURE-BOOT · revoke unused slots</Button>
                  <Button variant="secondary" disabled={operationBusy || !useRollback} onClick={() => void runRuntimeFuse("rollback", "ROLLBACK-REQUIRED")}>ROLLBACK-REQUIRED · reject versionless images</Button>
                  <Button variant="secondary" disabled={operationBusy || !otp?.rollbackRequired || rollbackTestPassed} onClick={startVersionlessRollbackTest}>Flash versionless rejection test</Button>
                  <Button variant="secondary" disabled={operationBusy || !rollbackTestStarted} onClick={restoreAfterRollbackTest}>Restore versioned image after rejection</Button>
                </div>
              </Stack>
            </Card>
          )}
        </Stack>

        {(busy || progress > 0) && <Progress value={progress} max={100} label={status} showValue animated={busy} />}
        {error && <Alert tone="danger" title="Security operation stopped">{error}</Alert>}
        {success && <Alert tone="success" title="Security operation complete">{success}</Alert>}
      </Stack>
    </Card>
  );
}
