import type { Env } from "../types.js";

export type OwnerAuthResult =
  | { authorized: true }
  | { authorized: false; status: 401 | 503; code: "OWNER_AUTH_REQUIRED" | "OWNER_AUTH_NOT_CONFIGURED" };

function equalSecret(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export function authorizeOwner(request: Request, env: Env): OwnerAuthResult {
  const expected = env.OWNER_CONTROL_TOKEN?.trim();
  if (!expected) return { authorized: false, status: 503, code: "OWNER_AUTH_NOT_CONFIGURED" };
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix) || !equalSecret(header.slice(prefix.length), expected)) return { authorized: false, status: 401, code: "OWNER_AUTH_REQUIRED" };
  return { authorized: true };
}
