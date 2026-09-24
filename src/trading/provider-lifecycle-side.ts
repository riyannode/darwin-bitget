export type ProviderLifecycleSide = "OPEN" | "CLOSE" | "CONTRADICTORY" | "UNRESOLVED";

export const PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS = 5_000;

export function isProviderLifecycleTimestampNear(value: string, reference: string): boolean {
  const valueTimestamp = Date.parse(value);
  const referenceTimestamp = Date.parse(reference);
  return Number.isFinite(valueTimestamp) && Number.isFinite(referenceTimestamp)
    && Math.abs(valueTimestamp - referenceTimestamp) <= PROVIDER_LIFECYCLE_TIME_TOLERANCE_MS;
}

export function resolveProviderLifecycleSide(
  side: string | null | undefined,
  positionSide: string | null | undefined,
  tradeSide: string | null | undefined,
): ProviderLifecycleSide {
  const normalizedSide = side?.trim().toLowerCase();
  const normalizedPositionSide = positionSide?.trim().toUpperCase();
  if ((normalizedSide !== "buy" && normalizedSide !== "sell")
    || (normalizedPositionSide !== "LONG" && normalizedPositionSide !== "SHORT")) return "UNRESOLVED";

  const derived: "OPEN" | "CLOSE" = (normalizedPositionSide === "LONG" && normalizedSide === "buy")
    || (normalizedPositionSide === "SHORT" && normalizedSide === "sell")
    ? "OPEN"
    : "CLOSE";
  const normalizedTradeSide = tradeSide?.trim().toLowerCase();
  if (!normalizedTradeSide) return derived;

  const explicitMatch = /^(open|close)(?:_(long|short))?$/.exec(normalizedTradeSide);
  if (!explicitMatch) return "UNRESOLVED";
  if (explicitMatch[2] && explicitMatch[2].toUpperCase() !== normalizedPositionSide) return "CONTRADICTORY";
  const explicit: "OPEN" | "CLOSE" = explicitMatch[1] === "open" ? "OPEN" : "CLOSE";
  return explicit === derived ? explicit : "CONTRADICTORY";
}
