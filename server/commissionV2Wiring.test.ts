import { afterEach, describe, expect, it } from "vitest";
import { FIVE_COMMISSION_DRAFT_V2 } from "../shared/commissionRulesV2";
import { buildInstallmentCommissionsV2 } from "./commissionAutomation";
import { COMMISSION_V2_ROLE_MAP, commissionV2Active, isCommissionV2Released, zeroRateSkippedRoles } from "./installmentCommissions";
import { parseCompleteCommissionPolicy } from "./projectPolicy";

// CRM-A13: o motor V2 ligado à geração por parcela, TRAVADO por padrão. Números na mão, sem banco.
const base = { cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix"], basis: "eligible_receipt" };
const policyWithV2 = JSON.stringify({ ...base, rulesV2: FIVE_COMMISSION_DRAFT_V2 });
const previous = process.env.COMMISSION_V2_RELEASED;
afterEach(() => { if (previous === undefined) delete process.env.COMMISSION_V2_RELEASED; else process.env.COMMISSION_V2_RELEASED = previous; });

describe("política V2 travada por padrão", () => {
  it("sem COMMISSION_V2_RELEASED a V2 nunca está ativa, mesmo com rulesV2 na política; e o V1 de 0% continua gerando o registro de skip", () => {
    delete process.env.COMMISSION_V2_RELEASED;
    const policy = parseCompleteCommissionPolicy(policyWithV2)!;
    expect(policy.rulesV2).toBeDefined();
    expect(isCommissionV2Released()).toBe(false);
    expect(commissionV2Active(policy)).toBe(false);
    expect(zeroRateSkippedRoles({ linerId: 1, closerId: 2 }, policy)).toEqual(["liner", "closer"]);
  });

  it("liberada, mas sem rulesV2 na política do empreendimento: continua V1 (nada muda)", () => {
    process.env.COMMISSION_V2_RELEASED = "true";
    const policy = parseCompleteCommissionPolicy(JSON.stringify(base))!;
    expect(commissionV2Active(policy)).toBe(false);
    expect(zeroRateSkippedRoles({ linerId: 1, closerId: 2 }, policy)).toEqual(["liner", "closer"]);
  });

  it("só 'true' libera: qualquer outro valor (1, TRUE, yes, vazio) segue travado", () => {
    const policy = parseCompleteCommissionPolicy(policyWithV2)!;
    for (const value of ["1", "TRUE", "yes", "", "false"]) { process.env.COMMISSION_V2_RELEASED = value; expect(commissionV2Active(policy)).toBe(false); }
    process.env.COMMISSION_V2_RELEASED = "true";
    expect(commissionV2Active(policy)).toBe(true);
    expect(zeroRateSkippedRoles({ linerId: 1, closerId: 2 }, policy)).toBeNull();
  });

  it("rulesV2 inválida na política recusa a política inteira (nunca vira 0% silencioso nem V2 parcial)", () => {
    expect(parseCompleteCommissionPolicy(JSON.stringify({ ...base, rulesV2: { schema: "tgr.commission-rules.v2", machineFeeBps: 20_000, roles: {} } }))).toBeNull();
  });

  it("mapa de papéis padrão: captador=promoter, consultor=liner, fechador=closer", () => {
    expect(COMMISSION_V2_ROLE_MAP).toEqual({ captador: "promoter", consultor: "liner", fechador: "closer" });
  });
});

describe("valor por parcela pelo V2 (rascunho da Five, entrada de R$ 4.000)", () => {
  const lines = [{ role: "promoter" as const, userId: 5, totalReais: 800 }, { role: "liner" as const, userId: 6, totalReais: 400 }, { role: "closer" as const, userId: 7, totalReais: 600 }];
  const common = { installmentId: 10, entryTotal: 4000, paymentMethod: "pix" as const, compensatedAt: new Date("2026-10-10T12:00:00Z"), calendar: { cancellationDeadlineDay: 7, expectedPaymentDay: 25 } };

  it("metade da entrada libera metade de cada papel, com a taxa e a base gravadas", () => {
    const rows = buildInstallmentCommissionsV2({ ...common, installmentAmount: 2000, lines });
    expect(rows.map(row => [row.commissionRole, row.sellerId, row.amount, row.baseAmount, row.rate])).toEqual([["promoter", 5, 400, 4000, 20], ["liner", 6, 200, 4000, 10], ["closer", 7, 300, 4000, 15]]);
  });

  it("nunca passa do total devido: parcela seguinte só libera o que falta; papel já quitado não ganha linha", () => {
    const rows = buildInstallmentCommissionsV2({ ...common, installmentAmount: 4000, lines, alreadyReleased: { promoter: 400, liner: 200, closer: 600 } });
    expect(rows.map(row => [row.commissionRole, row.amount])).toEqual([["promoter", 400], ["liner", 200]]);
  });

  it("papel de total 0 não gera linha (nada inventado)", () => {
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 2000, lines: [{ role: "closer", userId: 7, totalReais: 0 }] })).toEqual([]);
  });

  it("valor fixo por cota maior que a entrada limita a taxa gravada (coluna decimal(5,2)) sem perder o valor", () => {
    const [row] = buildInstallmentCommissionsV2({ ...common, entryTotal: 10, installmentAmount: 10, lines: [{ role: "promoter", userId: 5, totalReais: 400 }] });
    expect(row).toMatchObject({ amount: 400, rate: 999.99 });
  });
});
