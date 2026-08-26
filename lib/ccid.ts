const RESCUE_AID = Uint8Array.of(0xa0, 0x58, 0x3f, 0xc1, 0x9b, 0x7e, 0x4f, 0x21);
const CCID_CLASS = 0x0b;
const PC_TO_RDR_ICC_POWER_ON = 0x62;
const PC_TO_RDR_XFR_BLOCK = 0x6f;
const RDR_TO_PC_DATA_BLOCK = 0x80;
const COMMAND_STATUS_MASK = 0xc0;
const COMMAND_FAILED = 0x40;
const COMMAND_TIME_EXTENSION = 0x80;

export interface RuntimeSecureBootStatus {
  serial: string;
  enabled: boolean;
  locked: boolean;
  bootKeySlot: number | null;
  rollbackRequired: boolean;
  rollbackVersion: number;
  rollbackCapacity: number;
  source: "webusb" | "rsk-cli";
}

export function hasRuntimeWebUsb(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

export function requestRuntimeDevice(): Promise<USBDevice> {
  if (!hasRuntimeWebUsb()) throw new Error("This browser does not provide WebUSB.");
  return navigator.usb.requestDevice({
    filters: [
      { vendorId: 0x1209, productId: 0x0001 },
      { vendorId: 0x1050, productId: 0x0407 },
    ],
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Ccid {
  private interfaceNumber = -1;
  private inputEndpoint = -1;
  private outputEndpoint = -1;
  private sequence = 0;

  constructor(private readonly device: USBDevice) {}

  async open(): Promise<void> {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const configuration = this.device.configuration;
    if (!configuration) throw new Error("The runtime USB configuration is missing.");
    for (const candidate of configuration.interfaces) {
      for (const alternate of candidate.alternates) {
        const input = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in");
        const output = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
        if (alternate.interfaceClass === CCID_CLASS && input && output) {
          this.interfaceNumber = candidate.interfaceNumber;
          this.inputEndpoint = input.endpointNumber;
          this.outputEndpoint = output.endpointNumber;
          await this.device.claimInterface(this.interfaceNumber);
          if (candidate.alternate.alternateSetting !== alternate.alternateSetting) {
            await this.device.selectAlternateInterface(this.interfaceNumber, alternate.alternateSetting);
          }
          await this.exchange(PC_TO_RDR_ICC_POWER_ON);
          return;
        }
      }
    }
    throw new Error("The RS-Key CCID interface is unavailable or owned by the system smart-card driver.");
  }

  async close(): Promise<void> {
    if (!this.device.opened) return;
    if (this.interfaceNumber >= 0) {
      try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* Device can disconnect after reboot. */ }
    }
    try { await this.device.close(); } catch { /* Device can disconnect after reboot. */ }
  }

  private async readResponse(sequence: number): Promise<Uint8Array> {
    for (let extensions = 0; extensions < 120; extensions++) {
      const response = await this.device.transferIn(this.inputEndpoint, 4096);
      if (response.status !== "ok" || !response.data || response.data.byteLength < 10) {
        throw new Error("The CCID response is missing or truncated.");
      }
      const data = response.data;
      const type = data.getUint8(0);
      const length = data.getUint32(1, true);
      const slot = data.getUint8(5);
      const responseSequence = data.getUint8(6);
      const status = data.getUint8(7);
      const error = data.getUint8(8);
      if (type !== RDR_TO_PC_DATA_BLOCK || slot !== 0 || responseSequence !== sequence || length + 10 > data.byteLength) {
        throw new Error("The CCID response does not match the request.");
      }
      if ((status & COMMAND_STATUS_MASK) === COMMAND_TIME_EXTENSION) continue;
      if ((status & COMMAND_STATUS_MASK) === COMMAND_FAILED) {
        throw new Error(`CCID command failed with error 0x${error.toString(16).padStart(2, "0")}.`);
      }
      return new Uint8Array(data.buffer, data.byteOffset + 10, length).slice();
    }
    throw new Error("The device did not finish its physical-confirmation request.");
  }

  private async exchange(type: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()): Promise<Uint8Array> {
    const sequence = this.sequence++ & 0xff;
    const message = new Uint8Array(10 + payload.length);
    const view = new DataView(message.buffer);
    view.setUint8(0, type);
    view.setUint32(1, payload.length, true);
    view.setUint8(5, 0);
    view.setUint8(6, sequence);
    message.set(payload, 10);
    const sent = await this.device.transferOut(this.outputEndpoint, message);
    if (sent.status !== "ok" || sent.bytesWritten !== message.length) throw new Error("Could not send the CCID command.");
    return this.readResponse(sequence);
  }

  async transmit(apdu: Uint8Array): Promise<{ data: Uint8Array; status: number }> {
    const response = await this.exchange(PC_TO_RDR_XFR_BLOCK, apdu);
    if (response.length < 2) throw new Error("The APDU response has no status word.");
    const status = (response[response.length - 2] << 8) | response[response.length - 1];
    return { data: response.slice(0, -2), status };
  }

  async selectRescue(): Promise<string> {
    const response = await this.transmit(concat(Uint8Array.of(0x00, 0xa4, 0x04, 0x00, RESCUE_AID.length), RESCUE_AID, Uint8Array.of(0x00)));
    if (response.status !== 0x9000 || response.data.length < 12 || response.data[0] !== 1 || response.data[1] !== 2) {
      throw new Error(`RS-Key rescue applet SELECT failed with SW ${response.status.toString(16).padStart(4, "0")}.`);
    }
    return hex(response.data.slice(4, 12));
  }

  async readRuntimeStatus(): Promise<RuntimeSecureBootStatus> {
    const serial = await this.selectRescue();
    const secure = await this.transmit(Uint8Array.of(0x80, 0x1e, 0x03, 0x00, 0x00));
    if (secure.status !== 0x9000 || secure.data.length < 3) throw new Error("Could not read runtime secure-boot status.");
    const rollback = await this.transmit(Uint8Array.of(0x80, 0x1e, 0x06, 0x00, 0x00));
    if (rollback.status !== 0x9000 || rollback.data.length < 3) throw new Error("Could not read runtime anti-rollback status.");
    return {
      serial,
      enabled: Boolean(secure.data[0]),
      locked: Boolean(secure.data[1]),
      bootKeySlot: secure.data[2] === 0xff ? null : secure.data[2],
      rollbackRequired: Boolean(rollback.data[0]),
      rollbackVersion: rollback.data[1],
      rollbackCapacity: rollback.data[2],
      source: "webusb",
    };
  }

  async lockPage58(): Promise<void> {
    await this.selectRescue();
    const result = await this.transmit(concat(Uint8Array.of(0x80, 0x1b, 0x58, 0x00, 0x06), new TextEncoder().encode("LOCK58"), Uint8Array.of(0x00)));
    if (result.status !== 0x9000) throw new Error(`Page-58 lock failed with SW ${result.status.toString(16).padStart(4, "0")}.`);
  }

  async requireRollback(): Promise<void> {
    await this.selectRescue();
    const result = await this.transmit(concat(Uint8Array.of(0x80, 0x1b, 0x48, 0x00, 0x06), new TextEncoder().encode("ROLLBK"), Uint8Array.of(0x00)));
    if (result.status !== 0x9000) throw new Error(`ROLLBACK_REQUIRED failed with SW ${result.status.toString(16).padStart(4, "0")}.`);
  }

  async reboot(bootsel: boolean): Promise<void> {
    await this.selectRescue();
    try {
      const result = await this.transmit(Uint8Array.of(0x80, 0x1f, bootsel ? 1 : 0, 0x00, 0x00));
      if (result.status !== 0x9000) throw new Error(`Runtime reboot failed with SW ${result.status.toString(16).padStart(4, "0")}.`);
    } catch (error) {
      if (this.device.opened) throw error;
    }
  }
}

export async function readRuntimeSecureBootStatus(device: USBDevice): Promise<RuntimeSecureBootStatus> {
  const connection = new Ccid(device);
  await connection.open();
  try {
    return await connection.readRuntimeStatus();
  } finally {
    await connection.close();
  }
}

export function parseRskStatusJson(value: string): RuntimeSecureBootStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Paste the complete output from `rsk status --json`.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The rsk status output is invalid.");
  const root = parsed as Record<string, unknown>;
  const secure = root.secure_boot;
  if (!secure || typeof secure !== "object") throw new Error("The rsk output has no secure_boot status.");
  const status = secure as Record<string, unknown>;
  if (!status.rollback || typeof status.rollback !== "object") throw new Error("The rsk output has no anti-rollback status.");
  const rollback = status.rollback as Record<string, unknown>;
  const rootSerial = typeof root.serial === "string" ? root.serial.toLowerCase() : "";
  const secureSerial = typeof status.serial === "string" ? status.serial.toLowerCase() : "";
  if (!/^[0-9a-f]{16}$/.test(rootSerial) || secureSerial !== rootSerial || status.available !== true) {
    throw new Error("The rsk output does not identify one available RS-Key rescue applet.");
  }
  if (typeof status.enabled !== "boolean" || typeof status.locked !== "boolean") {
    throw new Error("The rsk secure-boot flags are invalid.");
  }
  const bootKey = status.bootkey;
  if (!Number.isInteger(bootKey) || ![0, 1, 2, 3, 0xff].includes(bootKey as number)) {
    throw new Error("The rsk boot-key slot is invalid.");
  }
  if (typeof rollback.required !== "boolean"
    || !Number.isInteger(rollback.version)
    || rollback.capacity !== 48
    || (rollback.version as number) < 0
    || (rollback.version as number) > 48) {
    throw new Error("The rsk anti-rollback status is invalid.");
  }
  return {
    serial: rootSerial,
    enabled: status.enabled,
    locked: status.locked,
    bootKeySlot: bootKey === 0xff ? null : bootKey as number,
    rollbackRequired: rollback.required,
    rollbackVersion: rollback.version as number,
    rollbackCapacity: 48,
    source: "rsk-cli",
  };
}
