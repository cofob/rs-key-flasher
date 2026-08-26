export interface RskSecureBootStatus {
  serial: string;
  enabled: boolean;
  locked: boolean;
  bootKeySlot: number | null;
  rollbackRequired: boolean;
  rollbackVersion: number;
  rollbackCapacity: number;
  source: "rsk-cli";
}

export function parseRskStatusJson(value: string): RskSecureBootStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Paste the complete output from `rsk status --json`.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The rsk status output is invalid.");
  const root = parsed as Record<string, unknown>;
  const secure = root.secure_boot;
  if (secure === null) {
    throw new Error("secure_boot is null. Start the normal RS-Key firmware, reconnect the device, and run rsk status again. Closing this tab can help if access is blocked, but it is not normally required.");
  }
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
