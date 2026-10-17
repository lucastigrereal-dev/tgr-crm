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

/**
 * Detalhe sem dado pessoal: a tela mostra idade, tempo de relacionamento e o texto livre do relacionamento, mas o Sales
 * só recebe frases fixas por critério e status (renda, idade, relacionamento e tempo nunca saem com o valor).
 */
const FIXED_DETAIL: Record<string, { ok: string; nq: string; missing: string; fixedMissing: string[] }> = {
  idade_homem: { ok: "Idade do homem acima do mínimo.", nq: "Idade do homem abaixo do mínimo.", missing: "Idade do homem a confirmar.", fixedMissing: ["Marque qual cônjuge é o homem.", "Idade do homem não informada."] },
  relacionamento: { ok: "Casado ou união estável.", nq: "Fora de casado ou união estável.", missing: "Relacionamento a confirmar pelo gerente.", fixedMissing: ["Relacionamento não informado."] },
  tempo_relacionamento: { ok: "Tempo de relacionamento acima do mínimo.", nq: "Tempo de relacionamento abaixo do mínimo.", missing: "Tempo de relacionamento a confirmar.", fixedMissing: ["Tempo de relacionamento não informado."] },
  renda: { ok: "Renda dentro do mínimo.", nq: "Renda abaixo do mínimo.", missing: "Renda a confirmar.", fixedMissing: ["Renda não informada."] },
};

export function toIntegrationNq(nq: NqResult) {
  return {
    criteria: nq.criteria.map(criterion => {
      const fixed = FIXED_DETAIL[criterion.key];
      const detail = !fixed ? criterion.detail : criterion.status === "missing" ? (fixed.fixedMissing.includes(criterion.detail) ? criterion.detail : fixed.missing) : fixed[criterion.status];
      return { key: criterion.key, status: criterion.status, detail };
    }),
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
