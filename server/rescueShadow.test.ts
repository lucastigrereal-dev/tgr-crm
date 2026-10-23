import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV } from "./_core/env";
import { evaluateCeilings, rescueDueAtFor, retentionSettingsInput, RETENTION_DEFAULTS } from "./rescueShadow";
import { domainEventDefinition } from "../shared/domainEvents";
import { canCapability } from "../shared/permissions";

const root = path.resolve(import.meta.dirname, "..");
const facts = { hasPaidCommission: false, hasOpenRenegotiation: false, recentPromise: false, paidPercent: 10 };

describe("F3.1 resgate em modo sombra: regras puras", () => {
  it("tetos da seção 10 do desenho, em ordem fixa; sem teto violado = teria rodado", () => {
    const s = { autoCancelMaxPaidPercent: 30 };
    expect(evaluateCeilings(facts, s)).toBeNull();
    expect(evaluateCeilings({ ...facts, paidPercent: 30 }, s)).toBeNull();
    expect(evaluateCeilings({ ...facts, paidPercent: 30.01 }, s)).toBe("over_cap");
    expect(evaluateCeilings({ ...facts, recentPromise: true }, s)).toBe("recent_promise");
    expect(evaluateCeilings({ ...facts, hasOpenRenegotiation: true, recentPromise: true }, s)).toBe("open_renegotiation");
    expect(evaluateCeilings({ hasPaidCommission: true, hasOpenRenegotiation: true, recentPromise: true, paidPercent: 99 }, s)).toBe("paid_commission");
  });
  it("prazo = primeira parcela vencida + N meses, limitado ao fim do mês de destino", () => {
    expect(rescueDueAtFor("2026-07-10", 3).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(rescueDueAtFor("2026-11-30", 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(rescueDueAtFor("2026-01-31", 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(rescueDueAtFor("2026-10-22", 24).toISOString()).toBe("2028-10-22T00:00:00.000Z");
  });
  it("padrões do desenho (provisórios) e limites da configuração", () => {
    expect(RETENTION_DEFAULTS).toEqual({ rescueWindowMonths: 3, rescueAlertLeadDays: 15, autoCancelEnabled: false, rescueReopenAfterDays: 90, autoCancelPromiseDays: 15, autoCancelMaxPaidPercent: 30 });
    const ok = { ...RETENTION_DEFAULTS };
    expect(retentionSettingsInput.safeParse(ok).success).toBe(true);
    for (const bad of [{ rescueWindowMonths: 0 }, { rescueWindowMonths: 25 }, { rescueAlertLeadDays: -1 }, { rescueReopenAfterDays: 0 }, { rescueReopenAfterDays: 731 }, { autoCancelMaxPaidPercent: 101 }, { autoCancelPromiseDays: 366 }, { rescueWindowMonths: 1.5 }]) expect(retentionSettingsInput.safeParse({ ...ok, ...bad }).success).toBe(false);
  });
});

describe("F3.1: nasce desligado, interno e sem poder de agir", () => {
  it("as duas flags nascem OFF (ENV), no compose e no .env.example", () => {
    expect(ENV.rescueQueueEnabled).toBe(false);
    expect(ENV.autoCancellationEnabled).toBe(false);
    const compose = readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8");
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    for (const name of ["RESCUE_QUEUE_ENABLED", "AUTO_CANCELLATION_ENABLED"]) {
      expect(compose).toContain(`${name}: "\${${name}:-false}"`);
      expect(example).toMatch(new RegExp(`^${name}=false`, "m"));
    }
  });
  it("o código do resgate NÃO importa nem chama nada que cancele contrato, mexa em parcela, comissão ou estoque (travado por varredura do fonte)", () => {
    const files = ["server/rescueShadow.ts", "server/rescueQueueJob.ts", "server/routers/rescue.ts"].map(file => readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
    for (const source of files) {
      expect(source).not.toMatch(/cancellationExecution|executeCancellation|decideCancellation|requestCancellation|contractCancellationRequests|cancellationDomain/);
      expect(source).not.toMatch(/\.update\(\s*(contracts|installments|salesCommissions|commercialFractions|financialTransactions)\b/);
      expect(source).not.toMatch(/\.insert\(\s*(financialTransactions|contractCancellationRequests)\b/);
    }
    expect(files[0]).not.toMatch(/ENV\.autoCancellationEnabled/); // a flag reservada não comanda nenhuma ação
  });
  it("eventos são internos: no catálogo, só com ids/datas/códigos e fora das pontes", async () => {
    const names = ["contract.rescue.opened", "contract.rescue.attempted", "contract.rescue.due_soon", "contract.rescue.resolved", "contract.auto_cancellation.would_run"] as const;
    const { toIntegrationEvent } = await import("../shared/integrationContract");
    const { FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const { CONTRACT_STATE_EVENT_NAMES } = await import("./relationshipBridge");
    for (const name of names) {
      expect(domainEventDefinition(name).aggregateType).toBe("contract_rescue_case");
      expect((FINANCIAL_EVENT_NAMES as readonly string[]).includes(name)).toBe(false);
      expect((CONTRACT_STATE_EVENT_NAMES as readonly string[]).includes(name)).toBe(false);
      const event = toIntegrationEvent({ id: 1, eventName: name, aggregateType: "contract_rescue_case", aggregateId: "1", actorUserId: null, occurredAt: new Date(0), payload: JSON.stringify({ caseId: 1, contractId: 2, note: "João 11999990000", phone: "11999990000", name: "X" }) });
      expect(JSON.stringify(event.payload)).not.toMatch(/João|11999990000|phone|name|note/);
    }
  });
  it("capacidades: pós-vendas (service) e admin trabalham a fila; só o admin configura", () => {
    expect(canCapability("service", "rescue.work")).toBe(true);
    expect(canCapability("admin", "rescue.work")).toBe(true);
    for (const role of ["seller", "finance", "user"] as const) expect(canCapability(role, "rescue.work")).toBe(false);
    expect(canCapability("admin", "rescue.configure")).toBe(true);
    for (const role of ["service", "seller", "finance", "user"] as const) expect(canCapability(role, "rescue.configure")).toBe(false);
  });
  it("as flags do resgate não passam pela tela de recursos (deny-list) e a migration segue só PROPOSTA", async () => {
    const { FLAG_DENYLIST, isAllowedFlag } = await import("./featureFlags");
    for (const key of ["RESCUE_QUEUE_ENABLED", "AUTO_CANCELLATION_ENABLED", "AUTO_CANCELLATION_DRY_RUN"]) { expect(FLAG_DENYLIST as readonly string[]).toContain(key); expect(isAllowedFlag(key)).toBe(false); }
    expect(readdirSync(path.join(root, "drizzle")).filter(file => /rescue|retention/i.test(file))).toEqual([]);
    expect(readdirSync(path.join(root, "migrations/proposed"))).toContain("PROPOSED_0086_rescue_and_auto_cancellation.sql");
  });
});
