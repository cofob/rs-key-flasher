import { eraseRanges, type Uf2Image } from "./uf2";

const RASPBERRY_PI_VID = 0x2e8a;
const RP2350_BOOT_PID = 0x000f;
const PICOBOOT_MAGIC = 0x431fd10b;
const IF_RESET = 0x41;
const IF_STATUS = 0x42;
const CMD_EXCLUSIVE = 0x01;
const CMD_FLASH_ERASE = 0x03;
const CMD_READ = 0x84;
const CMD_WRITE = 0x05;
const CMD_EXIT_XIP = 0x06;
const CMD_REBOOT2 = 0x0a;
const CMD_GET_INFO = 0x8b;
const CMD_OTP_READ = 0x8c;
const CMD_OTP_WRITE = 0x0d;
const REBOOT_FLASH_UPDATE = 0x04;
const CHUNK_SIZE = 4096;

const STATUS_NAMES = [
  "OK", "unknown command", "invalid command length", "invalid transfer length",
  "invalid address", "bad alignment", "interleaved write", "rebooting",
  "unknown error", "invalid state", "not permitted", "invalid argument",
  "buffer too small", "precondition not met", "modified data", "invalid data",
  "not found", "unsupported modification",
];

export type FlashStage = "connect" | "erase" | "write" | "verify" | "reboot";
export type FlashProgress = (stage: FlashStage, completed: number, total: number) => void;

export function hasWebUsb(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

export function requestPicobootDevice(): Promise<USBDevice> {
  if (!hasWebUsb()) throw new Error("This browser does not provide WebUSB.");
  return navigator.usb.requestDevice({
    filters: [{ vendorId: RASPBERRY_PI_VID, productId: RP2350_BOOT_PID }],
  });
}

function rangeArgs(address: number, size: number): Uint8Array {
  const args = new Uint8Array(8);
  const view = new DataView(args.buffer);
  view.setUint32(0, address, true);
  view.setUint32(4, size, true);
  return args;
}

function otpArgs(row: number, count: number, ecc: boolean): Uint8Array {
  if (!Number.isInteger(row) || !Number.isInteger(count) || row < 0 || row > 0xffff || count < 1 || count > 0xffff) {
    throw new Error("Invalid OTP row range.");
  }
  const args = new Uint8Array(5);
  const view = new DataView(args.buffer);
  view.setUint16(0, row, true);
  view.setUint16(2, count, true);
  view.setUint8(4, ecc ? 1 : 0);
  return args;
}

export class Picoboot {
  private interfaceNumber = -1;
  private inEndpoint = -1;
  private outEndpoint = -1;
  private token = 1;

  constructor(private readonly device: USBDevice) {}

  async open(): Promise<void> {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);

    const configuration = this.device.configuration;
    if (!configuration) throw new Error("The BOOTSEL USB configuration is missing.");

    for (const candidate of configuration.interfaces) {
      for (const alternate of candidate.alternates) {
        const input = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in");
        const output = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
        if (alternate.interfaceClass === 0xff && input && output) {
          this.interfaceNumber = candidate.interfaceNumber;
          this.inEndpoint = input.endpointNumber;
          this.outEndpoint = output.endpointNumber;
          await this.device.claimInterface(this.interfaceNumber);
          if (candidate.alternate.alternateSetting !== alternate.alternateSetting) {
            await this.device.selectAlternateInterface(this.interfaceNumber, alternate.alternateSetting);
          }
          await this.reset();
          return;
        }
      }
    }
    throw new Error("The picoboot USB interface was not found.");
  }

  async close(releaseExclusive = true): Promise<void> {
    if (!this.device.opened) return;
    if (releaseExclusive && this.interfaceNumber >= 0) {
      try { await this.exclusive(0); } catch { /* Device can disconnect after reboot. */ }
    }
    if (this.interfaceNumber >= 0) {
      try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* Already disconnected. */ }
    }
    try { await this.device.close(); } catch { /* Already disconnected. */ }
  }

  private async reset(): Promise<void> {
    try { await this.device.clearHalt("in", this.inEndpoint); } catch { /* Endpoint was not stalled. */ }
    try { await this.device.clearHalt("out", this.outEndpoint); } catch { /* Endpoint was not stalled. */ }
    const result = await this.device.controlTransferOut({
      requestType: "vendor",
      recipient: "interface",
      request: IF_RESET,
      value: 0,
      index: this.interfaceNumber,
    });
    if (result.status !== "ok") throw new Error("Could not reset the picoboot interface.");
  }

  private async command(
    commandId: number,
    args: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    data?: Uint8Array<ArrayBufferLike> | number,
  ): Promise<Uint8Array> {
    const transferLength = typeof data === "number" ? data : data?.byteLength ?? 0;
    const packet = new Uint8Array(32);
    const view = new DataView(packet.buffer);
    view.setUint32(0, PICOBOOT_MAGIC, true);
    view.setUint32(4, this.token++, true);
    view.setUint8(8, commandId);
    view.setUint8(9, args.byteLength);
    view.setUint32(12, transferLength, true);
    packet.set(args, 16);

    await this.transferOut(packet, "command");
    let received: Uint8Array = new Uint8Array();

    if (transferLength && (commandId & 0x80)) {
      const result = await this.device.transferIn(this.inEndpoint, transferLength);
      if (result.status !== "ok" || !result.data || result.data.byteLength !== transferLength) {
        await this.throwStatus("read");
      }
      received = new Uint8Array(result.data!.buffer, result.data!.byteOffset, result.data!.byteLength).slice();
    } else if (transferLength && data instanceof Uint8Array) {
      await this.transferOut(data, "data");
    }

    if (commandId & 0x80) {
      const ack = await this.device.transferOut(this.outEndpoint, new Uint8Array());
      if (ack.status !== "ok" || ack.bytesWritten !== 0) await this.throwStatus("acknowledgement");
    } else {
      const ack = await this.device.transferIn(this.inEndpoint, 1);
      if (ack.status !== "ok" || (ack.data?.byteLength ?? 0) !== 0) await this.throwStatus("acknowledgement");
    }

    return received;
  }

  private async transferOut(data: Uint8Array, label: string): Promise<void> {
    const owned = new Uint8Array(data.byteLength);
    owned.set(data);
    const result = await this.device.transferOut(this.outEndpoint, owned);
    if (result.status !== "ok" || result.bytesWritten !== data.byteLength) await this.throwStatus(label);
  }

  private async throwStatus(action: string): Promise<never> {
    try {
      const result = await this.device.controlTransferIn({
        requestType: "vendor",
        recipient: "interface",
        request: IF_STATUS,
        value: 0,
        index: this.interfaceNumber,
      }, 16);
      if (result.status === "ok" && result.data?.byteLength === 16) {
        const code = result.data.getUint32(4, true);
        throw new Error(`picoboot ${action} failed: ${STATUS_NAMES[code] ?? `status ${code}`}.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("picoboot")) throw error;
    }
    throw new Error(`picoboot ${action} failed.`);
  }

  exclusive(level: number): Promise<Uint8Array> {
    return this.command(CMD_EXCLUSIVE, Uint8Array.of(level));
  }

  exitXip(): Promise<Uint8Array> {
    return this.command(CMD_EXIT_XIP);
  }

  erase(address: number, size: number): Promise<Uint8Array> {
    return this.command(CMD_FLASH_ERASE, rangeArgs(address, size));
  }

  write(address: number, data: Uint8Array): Promise<Uint8Array> {
    return this.command(CMD_WRITE, rangeArgs(address, data.byteLength), data);
  }

  read(address: number, size: number): Promise<Uint8Array> {
    return this.command(CMD_READ, rangeArgs(address, size), size);
  }

  getInfo(type: number, params = new Uint32Array(3), size = 256): Promise<Uint8Array> {
    if (this.device.productId !== RP2350_BOOT_PID) throw new Error("GET_INFO is only available on RP2350.");
    const args = new Uint8Array(16);
    const view = new DataView(args.buffer);
    view.setUint8(0, type);
    for (let index = 0; index < Math.min(params.length, 3); index++) view.setUint32(4 + index * 4, params[index], true);
    return this.command(CMD_GET_INFO, args, size);
  }

  otpRead(row: number, count: number, ecc = false): Promise<Uint8Array> {
    if (this.device.productId !== RP2350_BOOT_PID) throw new Error("OTP access is only available on RP2350.");
    return this.command(CMD_OTP_READ, otpArgs(row, count, ecc), count * (ecc ? 2 : 4));
  }

  otpWrite(row: number, data: Uint8Array, ecc = false): Promise<Uint8Array> {
    if (this.device.productId !== RP2350_BOOT_PID) throw new Error("OTP access is only available on RP2350.");
    const rowSize = ecc ? 2 : 4;
    if (!data.length || data.length % rowSize) throw new Error(`OTP data must use ${rowSize}-byte rows.`);
    return this.command(CMD_OTP_WRITE, otpArgs(row, data.length / rowSize, ecc), data);
  }

  async reboot(): Promise<void> {
    const args = new Uint8Array(16);
    const view = new DataView(args.buffer);
    view.setUint32(0, REBOOT_FLASH_UPDATE, true);
    view.setUint32(4, 500, true);
    await this.command(CMD_REBOOT2, args);
  }
}

export async function flashUf2(device: USBDevice, image: Uf2Image, progress: FlashProgress): Promise<void> {
  if (device.vendorId !== RASPBERRY_PI_VID || device.productId !== image.productId) {
    throw new Error(`This UF2 targets ${image.familyName}, but the selected BOOTSEL device is different.`);
  }

  const connection = new Picoboot(device);
  let rebooted = false;
  progress("connect", 0, 1);
  try {
    await connection.open();
    await connection.exclusive(1);
    progress("connect", 1, 1);

    const ranges = eraseRanges(image);
    for (let index = 0; index < ranges.length; index++) {
      await connection.exitXip();
      await connection.erase(ranges[index].address, ranges[index].size);
      progress("erase", index + 1, ranges.length);
    }

    await connection.exitXip();
    let written = 0;
    for (const segment of image.segments) {
      for (let offset = 0; offset < segment.data.length; offset += CHUNK_SIZE) {
        const chunk = segment.data.subarray(offset, Math.min(offset + CHUNK_SIZE, segment.data.length));
        await connection.write(segment.address + offset, chunk);
        written += chunk.length;
        progress("write", written, image.totalBytes);
      }
    }

    await connection.exitXip();
    let verified = 0;
    for (const segment of image.segments) {
      for (let offset = 0; offset < segment.data.length; offset += CHUNK_SIZE) {
        const expected = segment.data.subarray(offset, Math.min(offset + CHUNK_SIZE, segment.data.length));
        const actual = await connection.read(segment.address + offset, expected.length);
        for (let index = 0; index < expected.length; index++) {
          if (expected[index] !== actual[index]) {
            const address = segment.address + offset + index;
            throw new Error(`Flash verification failed at 0x${address.toString(16)}.`);
          }
        }
        verified += expected.length;
        progress("verify", verified, image.totalBytes);
      }
    }

    progress("reboot", 0, 1);
    await connection.reboot();
    rebooted = true;
    progress("reboot", 1, 1);
  } finally {
    await connection.close(!rebooted);
  }
}
