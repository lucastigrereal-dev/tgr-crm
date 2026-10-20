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

/** Origem do Umami (VITE_ANALYTICS_ENDPOINT, mesma que o client usa): libera script e envio de dados só para ela. */
export function analyticsOrigin(endpoint = process.env.VITE_ANALYTICS_ENDPOINT): string | null {
  if (!endpoint || !process.env.VITE_ANALYTICS_WEBSITE_ID) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(scriptHashes: string[] = inlineScriptHashes, analytics: string | null = analyticsOrigin()) {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes, ...(analytics ? [analytics] : [])].join(" "),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    ["connect-src 'self'", ...(analytics ? [analytics] : [])].join(" "),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CRM-A26: toda resposta de /api carrega dado de sessão ou de portal por token; nada disso pode ficar em cache de navegador ou proxy.
 * Rotas que já definem Cache-Control (ex.: SSE, storage) mantêm o seu: o header só é posto se ainda não existir quando a resposta sai.
 */
export const apiNoStore: RequestHandler = (req, res, next) => {
  if ((req.path ?? "").startsWith("/api/")) {
    const original = res.writeHead;
    res.writeHead = function patched(this: typeof res, ...args: Parameters<typeof original>) {
      if (!this.getHeader("Cache-Control")) this.setHeader("Cache-Control", "no-store");
      return original.apply(this, args);
    } as typeof res.writeHead;
  }
  next();
};

/**
 * CRM-A26 (defesa em profundidade além do SameSite=Lax): com CSRF_ORIGIN_CHECK_ENABLED=true, mutação em /api/trpc cujo Origin
 * (quando o navegador envia) não é a própria origem nem está em CSRF_ALLOWED_ORIGINS (lista separada por vírgula) é recusada com 403.
 * Sem Origin (cliente não navegador, webhook) passa: a autenticação continua sendo da sessão/chave. Desligado por padrão.
 */
export function createOriginGuard(options: { enabled: boolean; allowedOrigins?: string[] }): RequestHandler {
  const allowed = new Set((options.allowedOrigins ?? []).map(origin => origin.trim().replace(/\/+$/, "")).filter(Boolean));
  return (req, res, next) => {
    if (!options.enabled || !req.path.startsWith("/api/trpc") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin) return next();
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* Origin ilegível */ }
    if (originHost && originHost === req.get("host")) return next();
    if (allowed.has(origin.replace(/\/+$/, ""))) return next();
    res.status(403).json({ error: "Origem não autorizada." });
  };
}

export const applySecurityHeaders: RequestHandler = (req, res, next) => {
  Object.entries(securityHeaders).forEach(([name, value]) => res.setHeader(name, value));
  apiNoStore(req, res, () => undefined);
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", buildContentSecurityPolicy());
  }
  next();
};
