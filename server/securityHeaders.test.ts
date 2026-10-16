import { describe, expect, it, vi } from "vitest";
import { applySecurityHeaders, buildContentSecurityPolicy, inlineScriptHashesFromHtml, registerInlineScriptHashes, securityHeaders } from "./securityHeaders";

describe("headers de segurança", () => {
  it("aplica cabeçalhos defensivos sem interromper a requisição", () => {
    const setHeader = vi.fn(); const next = vi.fn();
    applySecurityHeaders({} as never, { setHeader } as never, next);
    expect(setHeader).toHaveBeenCalledTimes(Object.keys(securityHeaders).length);
    expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(next).toHaveBeenCalledOnce();
  });

  it("CSP só em produção, sem script inline nem origem de script externa", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const setHeader = vi.fn();
      applySecurityHeaders({} as never, { setHeader } as never, vi.fn());
      expect(setHeader).toHaveBeenCalledWith("Content-Security-Policy", buildContentSecurityPolicy());
      process.env.NODE_ENV = "test";
      const dev = vi.fn();
      applySecurityHeaders({} as never, { setHeader: dev } as never, vi.fn());
      expect(dev).not.toHaveBeenCalledWith("Content-Security-Policy", expect.anything());
    } finally {
      process.env.NODE_ENV = original;
    }
    const csp = buildContentSecurityPolicy([]);
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });

  it("libera o script inline do build só por hash sha256, ignorando <script src>", () => {
    const html = '<script type="module" src="/a.js"></script><script id="rt">window.x=1</script>';
    const hashes = inlineScriptHashesFromHtml(html);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    registerInlineScriptHashes(html);
    try {
      expect(buildContentSecurityPolicy()).toContain(`script-src 'self' ${hashes[0]};`);
    } finally {
      registerInlineScriptHashes("");
    }
  });
});
