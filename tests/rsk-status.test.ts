import { describe, expect, it } from "vitest";
import { parseRskStatusJson } from "../lib/rsk-status";

describe("rsk CLI status", () => {
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

  it("rejects missing or null rescue status", () => {
    expect(() => parseRskStatusJson("{}")).toThrow(/secure_boot/);
    expect(() => parseRskStatusJson(JSON.stringify({ secure_boot: null }))).toThrow(/not normally required/);
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
});
