import { describe, expect, it } from "vitest";
import { flashUf2, Picoboot } from "../lib/picoboot";
import type { Uf2Image } from "../lib/uf2";

class FakeUsb {
  vendorId = 0x2e8a;
  productId = 0x000f;
  opened = false;
  commands: number[] = [];
  corruptRead = false;
  private pending: { id: number; address: number; size: number } | null = null;
  private memory = new Uint8Array(0x4000).fill(0xff);
  private alternate = {
    alternateSetting: 0,
    interfaceClass: 0xff,
    endpoints: [
      { type: "bulk", direction: "in", endpointNumber: 1 },
      { type: "bulk", direction: "out", endpointNumber: 2 },
    ],
  };
  configuration = {
    interfaces: [{ interfaceNumber: 0, alternate: this.alternate, alternates: [this.alternate] }],
  };

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {}
  async selectAlternateInterface() {}
  async clearHalt() {}
  async controlTransferOut() { return { status: "ok", bytesWritten: 0 }; }
  async controlTransferIn() { return { status: "ok", data: new DataView(new ArrayBuffer(16)) }; }

  async transferOut(_endpoint: number, source: BufferSource) {
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

    if (bytes.byteLength === 32 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x431fd10b) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const id = view.getUint8(8);
      const address = view.getUint32(16, true);
      const size = view.getUint32(20, true);
      this.pending = { id, address, size };
      this.commands.push(id);
      if (id === 0x03) this.memory.fill(0xff, address - 0x10000000, address - 0x10000000 + size);
    } else if (bytes.byteLength && this.pending?.id === 0x05) {
      this.memory.set(bytes, this.pending.address - 0x10000000);
    }
    return { status: "ok", bytesWritten: bytes.byteLength };
  }

  async transferIn(_endpoint: number, length: number) {
    if (length > 1 && this.pending?.id === 0x84) {
      const start = this.pending.address - 0x10000000;
      const bytes = this.memory.slice(start, start + length);
      if (this.corruptRead) bytes[0] ^= 1;
      return { status: "ok", data: new DataView(bytes.buffer) };
    }
    if (length > 1 && this.pending?.id === 0x8c) {
      const bytes = new Uint8Array(length).fill(0x5a);
      return { status: "ok", data: new DataView(bytes.buffer) };
    }
    return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
  }
}

function image(): Uf2Image {
  return {
    familyId: 0xe48bff59,
    familyName: "RP2350 Arm Secure",
    productId: 0x000f,
    segments: [{ address: 0x10000000, data: new Uint8Array(256).fill(0xa5) }],
    totalBytes: 256,
  };
}

describe("picoboot flashing", () => {
  it("writes, reads back, verifies, then reboots", async () => {
    const usb = new FakeUsb();
    const stages: string[] = [];
    await flashUf2(usb as unknown as USBDevice, image(), (stage) => stages.push(stage));
    expect(stages).toContain("verify");
    expect(usb.commands).toContain(0x84);
    expect(usb.commands.at(-1)).toBe(0x0a);
  });

  it("does not reboot when read-back verification fails", async () => {
    const usb = new FakeUsb();
    usb.corruptRead = true;
    await expect(flashUf2(usb as unknown as USBDevice, image(), () => {})).rejects.toThrow(/verification failed/);
    expect(usb.commands).not.toContain(0x0a);
  });

  it("uses RP2350 picoboot OTP read and write commands", async () => {
    const usb = new FakeUsb();
    const connection = new Picoboot(usb as unknown as USBDevice);
    await connection.open();
    await connection.exclusive(1);
    expect(await connection.otpRead(0x80, 2, true)).toEqual(new Uint8Array(4).fill(0x5a));
    await connection.otpWrite(0x80, Uint8Array.of(1, 2, 3, 4), true);
    await connection.close();
    expect(usb.commands).toContain(0x8c);
    expect(usb.commands).toContain(0x0d);
  });
});
