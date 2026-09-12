function parseDecimal(value: string): { integer: bigint; scale: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[2]) throw new Error("INVALID_DECIMAL");
  const scale = match[3]?.length ?? 0;
  const integer = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`);
  return { integer, scale };
}

function decimalText(integer: bigint, scale: number): string {
  const negative = integer < 0n;
  const absolute = (negative ? -integer : integer).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${absolute}`;
  const fraction = absolute.slice(-scale).replace(/0+$/, "");
  const whole = absolute.slice(0, -scale);
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole}`;
}

export function addDecimal(left: string, right: string): string {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftInteger = leftValue.integer * 10n ** BigInt(scale - leftValue.scale);
  const rightInteger = rightValue.integer * 10n ** BigInt(scale - rightValue.scale);
  return decimalText(leftInteger + rightInteger, scale);
}

export function isDecimal(value: string | undefined): value is string {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim());
}
