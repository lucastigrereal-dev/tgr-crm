import { describe, expect, it, vi } from "vitest";
import { applySecurityHeaders, securityHeaders } from "./securityHeaders";

describe("headers de segurança", () => {
  it("aplica cabeçalhos defensivos sem interromper a requisição", () => {
    const setHeader = vi.fn(); const next = vi.fn();
    applySecurityHeaders({} as never, { setHeader } as never, next);
    expect(setHeader).toHaveBeenCalledTimes(Object.keys(securityHeaders).length);
    expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(next).toHaveBeenCalledOnce();
  });
});
