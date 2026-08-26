import { describe, expect, it } from "vitest";
import { normalizeRp2350Serial, rp2350SerialsMatch } from "../lib/device-serial";

describe("RP2350 device serials", () => {
  it("matches BOOTSEL and runtime byte orders", () => {
    expect(rp2350SerialsMatch("E6613488D418224A2FF7", "f72f4a2218d48834")).toBe(true);
  });

  it("matches identical normalized serials", () => {
    expect(rp2350SerialsMatch("34:88:d4:18:22:4a:2f:f7", "3488D418224A2FF7")).toBe(true);
  });

  it("rejects different or incomplete serials", () => {
    expect(rp2350SerialsMatch("E6613488D418224A2FF7", "0011223344556677")).toBe(false);
    expect(rp2350SerialsMatch("3488", "8834")).toBe(false);
    expect(normalizeRp2350Serial("not-a-serial")).toBe("");
  });
});
