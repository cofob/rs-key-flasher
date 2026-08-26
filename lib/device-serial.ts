export function normalizeRp2350Serial(value: string): string {
  const normalized = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  return normalized.length >= 16 ? normalized.slice(-16) : "";
}

function reverseHexBytes(value: string): string {
  return value.match(/../g)?.reverse().join("") ?? "";
}

export function rp2350SerialsMatch(left: string, right: string): boolean {
  const a = normalizeRp2350Serial(left);
  const b = normalizeRp2350Serial(right);
  return Boolean(a && b && (a === b || reverseHexBytes(a) === b));
}
