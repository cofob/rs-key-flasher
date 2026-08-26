import { describe, expect, it } from "vitest";
import { Ccid, parseRskStatusJson, readRuntimeSecureBootStatus } from "../lib/ccid";

class FakeCcidUsb {
  opened = false;
  apdus: Uint8Array[] = [];
  private pending: { type: number; sequence: number; apdu: Uint8Array } | null = null;
  private extendOnce = true;
  private alternate = {
    alternateSetting: 0,
    interfaceClass: 0x0b,
    endpoints: [
      { type: "bulk", direction: "in", endpointNumber: 1 },
      { type: "bulk", direction: "out", endpointNumber: 2 },
    ],
  };
  configuration = {
    interfaces: [{ interfaceNumber: 1, alternate: this.alternate, alternates: [this.alternate] }],
  };

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {}
  async selectAlternateInterface() {}

  async transferOut(_endpoint: number, source: BufferSource) {
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    this.pending = { type: bytes[0], sequence: bytes[6], apdu: bytes.slice(10) };
    if (bytes[0] === 0x6f) this.apdus.push(bytes.slice(10));
    return { status: "ok", bytesWritten: bytes.length };
  }

  async transferIn() {
    if (!this.pending) throw new Error("No pending CCID message.");
    if (this.pending.type === 0x6f && this.extendOnce) {
      this.extendOnce = false;
      return { status: "ok", data: this.response(new Uint8Array(), 0x80) };
    }
    let payload = new Uint8Array();
    if (this.pending.type === 0x6f) {
      const apdu = this.pending.apdu;
      if (apdu[1] === 0xa4) payload = Uint8Array.of(1, 2, 8, 6, 0xe6, 0x61, 1, 2, 3, 4, 5, 6, 0x90, 0x00);
      else if (apdu[2] === 0x03) payload = Uint8Array.of(1, 0, 0, 0x90, 0x00);
      else if (apdu[2] === 0x06) payload = Uint8Array.of(0, 2, 48, 0x90, 0x00);
      else payload = Uint8Array.of(0x90, 0x00);
    }
    return { status: "ok", data: this.response(payload, 0) };
  }

  private response(payload: Uint8Array, status: number): DataView {
    const bytes = new Uint8Array(10 + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 0x80);
    view.setUint32(1, payload.length, true);
    view.setUint8(6, this.pending!.sequence);
    view.setUint8(7, status);
    bytes.set(payload, 10);
    return view;
  }
}

describe("rsk CLI boot proof", () => {
  it("accepts structured status for one runtime device", () => {
    expect(parseRskStatusJson(JSON.stringify({
      serial: "e661012345678901",
      secure_boot: {
        available: true,
        serial: "e661012345678901",
        enabled: true,
        locked: false,
        bootkey: 1,
        rollback: { required: true, version: 3, capacity: 48 },
      },
    }))).toMatchObject({
      serial: "e661012345678901",
      enabled: true,
      bootKeySlot: 1,
      rollbackRequired: true,
      rollbackVersion: 3,
      source: "rsk-cli",
    });
  });

  it("rejects missing rescue status", () => {
    expect(() => parseRskStatusJson("{}")).toThrow(/secure_boot/);
    expect(() => parseRskStatusJson("not json")).toThrow(/complete output/);
  });

  it("rejects loose booleans, short serials, and invalid rollback values", () => {
    const valid = {
      serial: "e661012345678901",
      secure_boot: {
        available: true,
        serial: "e661012345678901",
        enabled: false,
        locked: false,
        bootkey: 0xff,
        rollback: { required: false, version: 0, capacity: 48 },
      },
    };
    expect(() => parseRskStatusJson(JSON.stringify({ ...valid, serial: "1", secure_boot: { ...valid.secure_boot, serial: "1" } }))).toThrow(/rescue applet/);
    expect(() => parseRskStatusJson(JSON.stringify({ ...valid, secure_boot: { ...valid.secure_boot, enabled: "false" } }))).toThrow(/flags/);
    expect(() => parseRskStatusJson(JSON.stringify({ ...valid, secure_boot: { ...valid.secure_boot, rollback: { required: false, version: 49, capacity: 48 } } }))).toThrow(/anti-rollback/);
    expect(() => parseRskStatusJson(JSON.stringify({ ...valid, secure_boot: { ...valid.secure_boot, rollback: undefined } }))).toThrow(/anti-rollback/);
  });

  it("reads rescue status through CCID and accepts a time extension", async () => {
    const status = await readRuntimeSecureBootStatus(new FakeCcidUsb() as unknown as USBDevice);
    expect(status).toMatchObject({
      serial: "e661010203040506",
      enabled: true,
      bootKeySlot: 0,
      rollbackRequired: false,
      rollbackVersion: 2,
      rollbackCapacity: 48,
      source: "webusb",
    });
  });

  it("sends both runtime reboot targets through the rescue applet", async () => {
    const usb = new FakeCcidUsb();
    const connection = new Ccid(usb as unknown as USBDevice);
    await connection.open();
    await connection.reboot(false);
    await connection.reboot(true);
    await connection.close();
    expect(usb.apdus.filter((apdu) => apdu[1] === 0x1f).map((apdu) => apdu[2])).toEqual([0, 1]);
  });
});
