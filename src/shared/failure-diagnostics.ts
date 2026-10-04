export const MAX_FAILURE_DIAGNOSTIC_LENGTH = 240;

export function boundedDiagnosticText(value: unknown, limit = MAX_FAILURE_DIAGNOSTIC_LENGTH): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, limit);
}

export function safeDiagnosticMessage(value: unknown, fallback: string): string {
  const text = boundedDiagnosticText(value);
  if (!text || /(prompt|system\s+message|api[_-]?key|bearer\s|secret|password|authorization)/i.test(text)) return fallback;
  return text;
}
