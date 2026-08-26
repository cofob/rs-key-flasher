import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Picoboot } from "./picoboot";

const CRIT1_ROW = 0x40;
const CRIT1_COPIES = 8;
const BOOT_FLAGS0_ROW = 0x48;
const BOOT_FLAGS1_ROW = 0x4b;
const BOOT_VERSION0_ROW = 0x4e;
const BOOT_VERSION1_ROW = 0x51;
const BOOTKEY0_ROW = 0x80;
const BOOTKEY_STRIDE = 0x10;
const PAGE1_LOCK_ROW = 0xf83;
const PAGE2_LOCK_ROW = 0xf85;
const PAGE_LOCK_BL_RO = 0x141414;
const ROLLBACK_REQUIRED_BIT = 1 << 11;
const DEVK_ROW = 0xe80;
const MKEK_ROW = 0xe90;
const KEY_ROWS = 16;
const CHAFF_OFFSET = 0x20;
const PAGE58_LOCK_ROW = 0xff5;
const PAGE58_LOCK_VALUE = 0x3c3c3c;

export interface SecureBootOtpState {
  serial: string;
  secureBootEnabled: boolean;
  debugDisabled: boolean;
  glitchDetectorEnabled: boolean;
  glitchSensitivity: number;
  keyValid: number;
  keyInvalid: number;
  trustedSlots: number[];
  fingerprints: Array<string | null>;
  page1Lock: number;
  page2Lock: number;
  pagesLocked: boolean;
  rollbackRequired: boolean;
  bootVersion: number;
  page58: "blank" | "present" | "locked";
  consistent: boolean;
  problems: string[];
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("The public-key fingerprint must contain 64 hex characters.");
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function rawValues(bytes: Uint8Array): number[] {
  if (bytes.length % 4) throw new Error("Invalid raw OTP response.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, index) => view.getUint32(index * 4, true) & 0xffffff);
}

function rawBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value & 0xffffff, true));
  return bytes;
}

function majority(values: number[]): number {
  if (values.length !== 3) throw new Error("RBIT-3 state requires three OTP rows.");
  return (values[0] & values[1]) | (values[0] & values[2]) | (values[1] & values[2]);
}

function rbit8(values: number[]): number {
  if (values.length !== CRIT1_COPIES) throw new Error("RBIT-8 state requires eight OTP rows.");
  let result = 0;
  for (let bit = 0; bit < 24; bit++) {
    if (values.filter((value) => value & (1 << bit)).length >= 3) result |= 1 << bit;
  }
  return result;
}

function same(values: number[]): boolean {
  return values.every((value) => value === values[0]);
}

function bitCount(value: number): number {
  let count = 0;
  for (let current = value >>> 0; current; current >>>= 1) count += current & 1;
  return count;
}

async function withPicoboot<T>(device: USBDevice, action: (connection: Picoboot) => Promise<T>): Promise<T> {
  const connection = new Picoboot(device);
  await connection.open();
  try {
    await connection.exclusive(1);
    return await action(connection);
  } finally {
    await connection.close();
  }
}

async function readState(connection: Picoboot, serial: string): Promise<SecureBootOtpState> {
  const crit1Rows = rawValues(await connection.otpRead(CRIT1_ROW, CRIT1_COPIES));
  const crit1 = rbit8(crit1Rows);
  const flags0Rows = rawValues(await connection.otpRead(BOOT_FLAGS0_ROW, 3));
  const flags1Rows = rawValues(await connection.otpRead(BOOT_FLAGS1_ROW, 3));
  const version0Rows = rawValues(await connection.otpRead(BOOT_VERSION0_ROW, 3));
  const version1Rows = rawValues(await connection.otpRead(BOOT_VERSION1_ROW, 3));
  const flags0 = majority(flags0Rows);
  const flags1 = majority(flags1Rows);
  const fingerprints: Array<string | null> = [];
  for (let slot = 0; slot < 4; slot++) {
    const fingerprint = await connection.otpRead(BOOTKEY0_ROW + slot * BOOTKEY_STRIDE, KEY_ROWS, true);
    fingerprints.push(fingerprint.some(Boolean) ? hex(fingerprint) : null);
  }
  const page1Lock = rawValues(await connection.otpRead(PAGE1_LOCK_ROW, 1))[0];
  const page2Lock = rawValues(await connection.otpRead(PAGE2_LOCK_ROW, 1))[0];
  const page58Locks = rawValues(await connection.otpRead(PAGE58_LOCK_ROW - 1, 2));
  const problems: string[] = [];

  let page58: SecureBootOtpState["page58"];
  if (page58Locks[1] === PAGE58_LOCK_VALUE) {
    page58 = "locked";
  } else {
    const rows = rawValues(await connection.otpRead(DEVK_ROW, KEY_ROWS * 4));
    if (!rows.some(Boolean)) {
      page58 = "blank";
    } else {
      page58 = "present";
      const devkRows = rows.slice(0, KEY_ROWS);
      const mkekRows = rows.slice(KEY_ROWS, KEY_ROWS * 2);
      const devkChaff = rows.slice(KEY_ROWS * 2, KEY_ROWS * 3);
      const mkekChaff = rows.slice(KEY_ROWS * 3, KEY_ROWS * 4);
      if (!devkRows.some(Boolean) || !mkekRows.some(Boolean)) problems.push("Page 58 has a missing DEVK or MKEK.");
      if (devkChaff.some((value, index) => value !== (devkRows[index] ^ 0xffffff))) {
        problems.push("Page 58 DEVK chaff does not match the key rows.");
      }
      if (mkekChaff.some((value, index) => value !== (mkekRows[index] ^ 0xffffff))) {
        problems.push("Page 58 MKEK chaff does not match the key rows.");
      }
      const devk = await connection.otpRead(DEVK_ROW, KEY_ROWS, true);
      const mkek = await connection.otpRead(MKEK_ROW, KEY_ROWS, true);
      if (!secp256k1.utils.isValidSecretKey(devk)) problems.push("Page 58 DEVK is not a valid secp256k1 scalar.");
      if (!mkek.some(Boolean)) problems.push("Page 58 MKEK is empty.");
    }
  }

  const keyValid = flags1 & 0xf;
  const keyInvalid = (flags1 >>> 8) & 0xf;
  const trustedSlots = Array.from({ length: 4 }, (_, slot) => slot)
    .filter((slot) => (keyValid & (1 << slot)) && !(keyInvalid & (1 << slot)));
  if (!same(crit1Rows)) problems.push("CRIT1 redundant rows differ.");
  if (!same(flags0Rows)) problems.push("BOOT_FLAGS0 redundant rows differ.");
  if (!same(flags1Rows)) problems.push("BOOT_FLAGS1 redundant rows differ.");
  if (!same(version0Rows) || !same(version1Rows)) problems.push("Rollback-version redundant rows differ.");
  if (page1Lock !== 0 && page1Lock !== PAGE_LOCK_BL_RO) problems.push("Page 1 has an unknown lock policy.");
  if (page2Lock !== 0 && page2Lock !== PAGE_LOCK_BL_RO) problems.push("Page 2 has an unknown lock policy.");
  if ((page1Lock === PAGE_LOCK_BL_RO) !== (page2Lock === PAGE_LOCK_BL_RO)) problems.push("Page 1 and page 2 lock states differ.");
  if (page58Locks[0] !== 0) problems.push("Page 58 LOCK0 is not blank.");
  if (page58Locks[1] !== 0 && page58Locks[1] !== PAGE58_LOCK_VALUE) problems.push("Page 58 has an unknown lock policy.");
  for (let slot = 0; slot < 4; slot++) {
    if ((keyValid & (1 << slot)) && !fingerprints[slot]) problems.push(`Slot ${slot} is valid but has no fingerprint.`);
    if (fingerprints[slot] && !(keyValid & (1 << slot))) problems.push(`Slot ${slot} has a fingerprint but is not KEY_VALID.`);
  }
  if ((crit1 & 1) && !trustedSlots.length) problems.push("Secure boot is enabled without a trusted key slot.");

  return {
    serial,
    secureBootEnabled: Boolean(crit1 & 1),
    debugDisabled: Boolean(crit1 & (1 << 2)),
    glitchDetectorEnabled: Boolean(crit1 & (1 << 4)),
    glitchSensitivity: (crit1 >>> 5) & 3,
    keyValid,
    keyInvalid,
    trustedSlots,
    fingerprints,
    page1Lock,
    page2Lock,
    pagesLocked: page1Lock === PAGE_LOCK_BL_RO && page2Lock === PAGE_LOCK_BL_RO,
    rollbackRequired: Boolean(flags0 & ROLLBACK_REQUIRED_BIT),
    bootVersion: bitCount(majority(version0Rows)) + bitCount(majority(version1Rows)),
    page58,
    consistent: problems.length === 0,
    problems,
  };
}

async function writeRawOr(connection: Picoboot, row: number, values: number[]): Promise<void> {
  const current = rawValues(await connection.otpRead(row, values.length));
  const desired = values.map((value, index) => value | current[index]);
  await connection.otpWrite(row, rawBytes(desired));
  const verified = rawValues(await connection.otpRead(row, values.length));
  if (verified.some((value, index) => value !== desired[index])) {
    throw new Error(`OTP verification failed at row 0x${row.toString(16)}.`);
  }
}

export async function readSecureBootOtpState(device: USBDevice): Promise<SecureBootOtpState> {
  if (device.productId !== 0x000f) throw new Error("Secure-boot OTP is only available on RP2350.");
  return withPicoboot(device, (connection) => readState(connection, device.serialNumber || "unknown"));
}

export async function burnPage58Secrets(device: USBDevice): Promise<SecureBootOtpState> {
  return withPicoboot(device, async (connection) => {
    const preflight = [
      ...rawValues(await connection.otpRead(DEVK_ROW, KEY_ROWS * 4)),
      ...rawValues(await connection.otpRead(PAGE58_LOCK_ROW - 1, 2)),
    ];
    if (preflight.some(Boolean)) throw new Error("Page 58 or its lock rows are not blank. Refusing to overwrite OTP.");

    const mkek = crypto.getRandomValues(new Uint8Array(32));
    let devk: Uint8Array;
    do devk = crypto.getRandomValues(new Uint8Array(32));
    while (!secp256k1.utils.isValidSecretKey(devk));
    try {
      await connection.otpWrite(DEVK_ROW, devk, true);
      if (!equal(await connection.otpRead(DEVK_ROW, KEY_ROWS, true), devk)) throw new Error("DEVK OTP verification failed.");
      await connection.otpWrite(MKEK_ROW, mkek, true);
      if (!equal(await connection.otpRead(MKEK_ROW, KEY_ROWS, true), mkek)) throw new Error("MKEK OTP verification failed.");

      for (const base of [DEVK_ROW, MKEK_ROW]) {
        const raw = rawValues(await connection.otpRead(base, KEY_ROWS));
        const chaff = raw.map((value) => value ^ 0xffffff);
        await connection.otpWrite(base + CHAFF_OFFSET, rawBytes(chaff));
        const verified = rawValues(await connection.otpRead(base + CHAFF_OFFSET, KEY_ROWS));
        if (verified.some((value, index) => value !== chaff[index])) throw new Error("OTP chaff verification failed.");
      }
    } finally {
      mkek.fill(0);
      devk.fill(0);
    }
    return readState(connection, device.serialNumber || "unknown");
  });
}

export async function loadBootKeyFingerprint(
  device: USBDevice,
  fingerprintHex: string,
): Promise<{ slot: number; state: SecureBootOtpState }> {
  const fingerprint = fromHex(fingerprintHex);
  return withPicoboot(device, async (connection) => {
    const before = await readState(connection, device.serialNumber || "unknown");
    if (!before.consistent) throw new Error(before.problems.join(" "));
    const existing = before.fingerprints.findIndex((value) => value === fingerprintHex.toLowerCase());
    if (existing >= 0 && before.trustedSlots.includes(existing)) return { slot: existing, state: before };
    if (existing >= 0) throw new Error(`Boot-key slot ${existing} contains this fingerprint but is not trusted. Refusing a partial-state repair.`);
    if (before.trustedSlots.length) throw new Error("This signing key does not match the trusted boot key on the device.");
    if (before.pagesLocked) throw new Error("Boot-key pages are already locked.");
    const slot = Array.from({ length: 4 }, (_, value) => value).find((candidate) =>
      !before.fingerprints[candidate] && !(before.keyValid & (1 << candidate)) && !(before.keyInvalid & (1 << candidate)));
    if (slot === undefined) throw new Error("No free secure-boot key slot is available.");

    const row = BOOTKEY0_ROW + slot * BOOTKEY_STRIDE;
    await connection.otpWrite(row, fingerprint, true);
    if (!equal(await connection.otpRead(row, KEY_ROWS, true), fingerprint)) {
      throw new Error(`Boot-key slot ${slot} verification failed.`);
    }
    const currentFlags = rawValues(await connection.otpRead(BOOT_FLAGS1_ROW, 3));
    const desired = majority(currentFlags) | (1 << slot);
    await writeRawOr(connection, BOOT_FLAGS1_ROW, [desired, desired, desired]);
    const state = await readState(connection, device.serialNumber || "unknown");
    if (!state.trustedSlots.includes(slot) || state.fingerprints[slot] !== fingerprintHex.toLowerCase()) {
      throw new Error(`Boot-key slot ${slot} did not become trusted.`);
    }
    return { slot, state };
  });
}

function requireTrustedFingerprint(state: SecureBootOtpState, fingerprintHex: string): void {
  const fingerprint = fingerprintHex.toLowerCase();
  const matches = state.trustedSlots.some((slot) => state.fingerprints[slot] === fingerprint);
  if (!matches) throw new Error("This signing key does not match a trusted secure-boot slot on the device.");
}

export async function hardenSecureBoot(device: USBDevice, fingerprintHex: string): Promise<SecureBootOtpState> {
  return withPicoboot(device, async (connection) => {
    const before = await readState(connection, device.serialNumber || "unknown");
    if (!before.consistent || !before.trustedSlots.length) throw new Error("A consistent trusted boot key is required before hardening.");
    requireTrustedFingerprint(before, fingerprintHex);
    const desired = rbit8(rawValues(await connection.otpRead(CRIT1_ROW, CRIT1_COPIES))) | 0x04 | 0x10 | 0x60;
    await writeRawOr(connection, CRIT1_ROW, Array(CRIT1_COPIES).fill(desired));
    const state = await readState(connection, device.serialNumber || "unknown");
    if (!state.debugDisabled || !state.glitchDetectorEnabled || state.glitchSensitivity !== 3) {
      throw new Error("Secure-boot hardening verification failed.");
    }
    return state;
  });
}

export async function enableSecureBoot(device: USBDevice, fingerprintHex: string): Promise<SecureBootOtpState> {
  return withPicoboot(device, async (connection) => {
    const before = await readState(connection, device.serialNumber || "unknown");
    if (!before.consistent || !before.trustedSlots.length) throw new Error("A trusted boot key is required before secure boot can be enabled.");
    requireTrustedFingerprint(before, fingerprintHex);
    if (!before.debugDisabled || !before.glitchDetectorEnabled || before.glitchSensitivity !== 3) {
      throw new Error("Run the hardening stage before secure-boot enforcement.");
    }
    if (!before.secureBootEnabled) {
      const desired = rbit8(rawValues(await connection.otpRead(CRIT1_ROW, CRIT1_COPIES))) | 1;
      await writeRawOr(connection, CRIT1_ROW, Array(CRIT1_COPIES).fill(desired));
    }
    const state = await readState(connection, device.serialNumber || "unknown");
    if (!state.secureBootEnabled) throw new Error("SECURE_BOOT_ENABLE verification failed.");
    return state;
  });
}

export async function lockSecureBootPages(device: USBDevice, fingerprintHex: string): Promise<SecureBootOtpState> {
  return withPicoboot(device, async (connection) => {
    const before = await readState(connection, device.serialNumber || "unknown");
    if (!before.consistent || !before.secureBootEnabled || before.trustedSlots.length !== 1) {
      throw new Error("Full lock requires secure boot and exactly one trusted key slot.");
    }
    requireTrustedFingerprint(before, fingerprintHex);
    if ((before.page1Lock & ~PAGE_LOCK_BL_RO) || (before.page2Lock & ~PAGE_LOCK_BL_RO)) {
      throw new Error("The key pages contain an unknown lock policy.");
    }
    const keep = before.trustedSlots[0];
    const invalid = (~(1 << keep)) & 0xf;
    const currentFlags = rawValues(await connection.otpRead(BOOT_FLAGS1_ROW, 3));
    const desiredFlags = majority(currentFlags) | (invalid << 8);
    await writeRawOr(connection, BOOT_FLAGS1_ROW, [desiredFlags, desiredFlags, desiredFlags]);
    await writeRawOr(connection, PAGE1_LOCK_ROW, [PAGE_LOCK_BL_RO]);
    await writeRawOr(connection, PAGE2_LOCK_ROW, [PAGE_LOCK_BL_RO]);
    const state = await readState(connection, device.serialNumber || "unknown");
    if (!state.pagesLocked || state.trustedSlots.length !== 1 || state.trustedSlots[0] !== keep) {
      throw new Error("Secure-boot page-lock verification failed.");
    }
    return state;
  });
}
