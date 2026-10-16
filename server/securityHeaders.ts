import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

export const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
  "Origin-Agent-Cluster": "?1",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Permitted-Cross-Domain-Policies": "none",
};

// KAN-30: CSP só em produção (o Vite do dev injeta script inline). O build injeta um script inline (runtime), então ele é
// liberado por HASH calculado do index.html no boot (registerInlineScriptHashes), nunca por 'unsafe-inline'. Estilo inline vem de
// Radix/Tailwind; fontes do Google; imagens de storage/avatares (https:); fetch e SSE só para a própria origem.
let inlineScriptHashes: string[] = [];

export function inlineScriptHashesFromHtml(html: string): string[] {
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1]) hashes.push(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  }
  return hashes;
}

export function registerInlineScriptHashes(html: string) {
  inlineScriptHashes = inlineScriptHashesFromHtml(html);
}

export function buildContentSecurityPolicy(scriptHashes: string[] = inlineScriptHashes) {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const applySecurityHeaders: RequestHandler = (_req, res, next) => {
  Object.entries(securityHeaders).forEach(([name, value]) => res.setHeader(name, value));
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", buildContentSecurityPolicy());
  }
  next();
};
