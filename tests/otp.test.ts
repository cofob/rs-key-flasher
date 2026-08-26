import { describe, expect, it } from "vitest";
import {
  hardenSecureBoot,
  readSecureBootOtpState,
} from "../lib/otp";

class FakeOtpUsb {
  vendorId = 0x2e8a;
  productId = 0x000f;
  serialNumber = "e661010203040506";
  opened = false;
  raw = new Uint32Array(0x1000);
  ecc = new Uint16Array(0x1000);
  private pending: { id: number; row: number; count: number; ecc: boolean } | null = null;
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

  setRaw(row: number, values: number[]) {
    values.forEach((value, index) => { this.raw[row + index] = value & 0xffffff; });
  }

  setEcc(row: number, bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < bytes.length / 2; index++) this.ecc[row + index] = view.getUint16(index * 2, true);
  }

  async transferOut(_endpoint: number, source: BufferSource) {
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    if (!bytes.length) return { status: "ok", bytesWritten: 0 };
    if (bytes.length === 32 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x431fd10b) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pending = {
        id: view.getUint8(8),
        row: view.getUint16(16, true),
        count: view.getUint16(18, true),
        ecc: Boolean(view.getUint8(20)),
      };
    } else if (this.pending?.id === 0x0d) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < this.pending.count; index++) {
        if (this.pending.ecc) this.ecc[this.pending.row + index] |= view.getUint16(index * 2, true);
        else this.raw[this.pending.row + index] |= view.getUint32(index * 4, true) & 0xffffff;
      }
    }
    return { status: "ok", bytesWritten: bytes.length };
  }

  async transferIn(_endpoint: number, length: number) {
    if (length > 1 && this.pending?.id === 0x8c) {
      const rowSize = this.pending.ecc ? 2 : 4;
      const bytes = new Uint8Array(this.pending.count * rowSize);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < this.pending.count; index++) {
        if (this.pending.ecc) view.setUint16(index * 2, this.ecc[this.pending.row + index], true);
        else view.setUint32(index * 4, this.raw[this.pending.row + index], true);
      }
      return { status: "ok", data: view };
    }
    return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
  }
}

function trustSlotZero(usb: FakeOtpUsb, fingerprint: Uint8Array): void {
  usb.setEcc(0x80, fingerprint);
  usb.setRaw(0x4b, [1, 1, 1]);
}

describe("secure-boot OTP state", () => {
  it("accepts the benign non-secure read-only page policy", async () => {
    const usb = new FakeOtpUsb();
    usb.setRaw(0xf83, [0x040404]);
    usb.setRaw(0xf85, [0x040404]);

    const state = await readSecureBootOtpState(usb as unknown as USBDevice);

    expect(state).toMatchObject({
      page1Lock: 0x040404,
      page2Lock: 0x040404,
      pagesLocked: false,
      consistent: true,
      problems: [],
    });
  });

  it("rejects partial CRIT1 RBIT-8 state", async () => {
    const usb = new FakeOtpUsb();
    usb.setRaw(0x40, [1, 0, 0, 0, 0, 0, 0, 0]);
    const state = await readSecureBootOtpState(usb as unknown as USBDevice);
    expect(state.secureBootEnabled).toBe(false);
    expect(state.consistent).toBe(false);
    expect(state.problems).toContain("CRIT1 redundant rows differ.");
  });

  it("writes and verifies every CRIT1 RBIT-8 copy", async () => {
    const usb = new FakeOtpUsb();
    const fingerprint = new Uint8Array(32).fill(0x11);
    trustSlotZero(usb, fingerprint);
    const state = await hardenSecureBoot(usb as unknown as USBDevice, "11".repeat(32));
    expect(Array.from(usb.raw.slice(0x40, 0x48))).toEqual(Array(8).fill(0x74));
    expect(state).toMatchObject({ consistent: true, debugDisabled: true, glitchDetectorEnabled: true, glitchSensitivity: 3 });
  });

  it("rejects a foreign signer before hardening", async () => {
    const usb = new FakeOtpUsb();
    trustSlotZero(usb, new Uint8Array(32).fill(0x11));
    await expect(hardenSecureBoot(usb as unknown as USBDevice, "22".repeat(32))).rejects.toThrow(/does not match/);
    expect(Array.from(usb.raw.slice(0x40, 0x48))).toEqual(Array(8).fill(0));
  });

  it("rejects partial page-58 key and chaff state", async () => {
    const usb = new FakeOtpUsb();
    usb.setRaw(0xe80, [1]);
    usb.setEcc(0xe80, Uint8Array.of(...new Uint8Array(31), 1));
    const state = await readSecureBootOtpState(usb as unknown as USBDevice);
    expect(state.page58).toBe("present");
    expect(state.consistent).toBe(false);
    expect(state.problems.join(" ")).toMatch(/missing DEVK or MKEK|chaff/);
  });

  it("accepts only the exact page-58 runtime lock policy", async () => {
    const locked = new FakeOtpUsb();
    locked.setRaw(0xff5, [0x3c3c3c]);
    await expect(readSecureBootOtpState(locked as unknown as USBDevice)).resolves.toMatchObject({ page58: "locked", consistent: true });

    const foreign = new FakeOtpUsb();
    foreign.setRaw(0xff5, [1]);
    const state = await readSecureBootOtpState(foreign as unknown as USBDevice);
    expect(state.consistent).toBe(false);
    expect(state.problems).toContain("Page 58 has an unknown lock policy.");
  });
});
