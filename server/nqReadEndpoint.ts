import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { NqResult } from "./captureSheetDomain";
import { logger } from "./logger";
import { nqByCoupleCode } from "./routers/captureSheet";

/**
 * Leitura do NQ (casal qualificado) pelo Sales Command (Frente C), server-to-server com a mesma chave de integração.
 * DESLIGADO por padrão (`NQ_READ_ENDPOINT_ENABLED`): com a flag desligada a rota responde 404 como se não existisse.
 * Só liga depois do aceite do Lucas. Devolve apenas o cálculo: nada de CPF, telefone nem renda bruta.
 *   GET /api/integrations/sales-command/nq/:coupleCode
 *   200 { coupleCode, nq: { criteria: [{ key, status, detail }], nqItems, missing, outcome, label } }
 */
export const NQ_READ_PATH = "/api/integrations/sales-command/nq/:coupleCode";

/** Remove do cálculo o que não pode sair: o valor da renda do casal (o detalhe vira só "dentro/abaixo do mínimo"). */
export function toIntegrationNq(nq: NqResult) {
  return {
    criteria: nq.criteria.map(criterion => ({
      key: criterion.key,
      status: criterion.status,
      detail: criterion.key === "renda" && criterion.status !== "missing" ? (criterion.status === "ok" ? "Renda dentro do mínimo." : "Renda abaixo do mínimo.") : criterion.detail,
    })),
    nqItems: nq.nqItems,
    missing: nq.missing,
    outcome: nq.outcome,
    label: nq.label,
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

async function handle(request: Request, response: Response, integrationKey: string) {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, integrationKey)) { response.status(401).json({ error: "Unauthorized" }); return; }
  const found = await nqByCoupleCode(String(request.params.coupleCode ?? ""));
  if (!found) { response.status(404).json({ error: "Not found" }); return; }
  response.status(200).json({ coupleCode: found.coupleCode, nq: toIntegrationNq(found.nq) });
}

export function registerNqReadEndpoint(app: Express, integrationKey: string | undefined, enabled: boolean) {
  app.get(NQ_READ_PATH, async (request, response) => {
    const key = integrationKey?.trim();
    // Desligado ou sem chave: a rota não existe para quem chama.
    if (!enabled || !key) { response.status(404).json({ error: "Not found" }); return; }
    try { await handle(request, response, key); }
    catch (error) {
      logger.error("NQ read failed", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ error: "Unavailable" });
    }
  });
}
