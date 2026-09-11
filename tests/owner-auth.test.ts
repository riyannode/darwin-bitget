import { describe, expect, it } from "vitest";
import { authorizeOwner } from "../src/agent/owner-auth.js";

describe("owner control authentication", () => {
  it("denies mutations when the control secret is not configured", () => {
    const result = authorizeOwner(new Request("https://example.test"), {} as never);
    expect(result).toMatchObject({ authorized: false, status: 503, code: "OWNER_AUTH_NOT_CONFIGURED" });
  });

  it("denies an invalid bearer token", () => {
    const request = new Request("https://example.test", { headers: { authorization: "Bearer wrong" } });
    const result = authorizeOwner(request, { OWNER_CONTROL_TOKEN: "right" } as never);
    expect(result).toMatchObject({ authorized: false, status: 401, code: "OWNER_AUTH_REQUIRED" });
  });

  it("accepts the configured bearer token", () => {
    const request = new Request("https://example.test", { headers: { authorization: "Bearer right" } });
    expect(authorizeOwner(request, { OWNER_CONTROL_TOKEN: "right" } as never)).toEqual({ authorized: true });
  });
});
