import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateNonBuyerEligibility, saleInProgress, type EligibilityFacts } from "./nonBuyerEligibility";

const closed = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T15:00:00Z"), ntKind: null, ntMotiveId: null, commercialOutcome: null,
  captureAnonymized: false, customerAnonymized: false, erasurePending: false, optedOut: false,
  // O CRM cria oportunidade new/qualified para TODA ficha captada: isso NÃO é venda em andamento.
  contractStatuses: [], proposalStatuses: [], opportunityStages: ["qualified"], ...over,
});
const noTour = (over: Partial<EligibilityFacts> = {}) => closed({ presentationStatus: "no_tour", presentationEndedAt: null, ntKind: "perfil", ntMotiveId: 7, ...over });
const why = (facts: EligibilityFacts) => evaluateNonBuyerEligibility(facts).reasons;

describe("elegibilidade de não-comprador (C2/C3 fatia 1): função pura", () => {
  it("atendimento encerrado sem venda, com oportunidade new/qualified: elegível pelo ramo A", () => {
    expect(evaluateNonBuyerEligibility(closed())).toEqual({ eligible: true, branch: "closed", reasons: [] });
    expect(evaluateNonBuyerEligibility(closed({ opportunityStages: ["new"] })).eligible).toBe(true);
    expect(evaluateNonBuyerEligibility(closed({ opportunityStages: ["lost"] })).eligible).toBe(true);
  });
  it("CAIU EM MESA entra pelo ramo A (encerrado) e é elegível; sem encerramento não", () => {
    expect(evaluateNonBuyerEligibility(closed({ commercialOutcome: "caiu_em_mesa" }))).toMatchObject({ eligible: true, branch: "closed" });
    expect(why(closed({ presentationStatus: "presented", commercialOutcome: "caiu_em_mesa" }))).toEqual(["attendance_not_finished"]);
  });
  it("não-tour com tipo e motivo é elegível pelo ramo B; sem tipo ou sem motivo não", () => {
    expect(evaluateNonBuyerEligibility(noTour())).toEqual({ eligible: true, branch: "no_tour", reasons: [] });
    expect(why(noTour({ ntKind: null }))).toEqual(["attendance_not_finished"]);
    expect(why(noTour({ ntMotiveId: null }))).toEqual(["attendance_not_finished"]);
  });
  it("atendimento em andamento ou ficha só captada/agendada/check-in não é elegível; closed sem presentationEndedAt também não", () => {
    for (const status of ["captured", "scheduled", "checked_in", "presented"]) expect(why(closed({ presentationStatus: status, presentationEndedAt: null })), status).toEqual(["attendance_not_finished"]);
    expect(why(closed({ presentationEndedAt: null }))).toEqual(["attendance_not_finished"]);
  });
  it("venda em andamento bloqueia: qualquer contrato exceto cancelled (inclui closed), proposta draft/sent/approved, oportunidade proposal/negotiation/won, VENDEU", () => {
    for (const status of ["draft", "pending_signature", "active", "overdue", "closed"]) expect(why(closed({ contractStatuses: [status] })), `contrato ${status}`).toEqual(["sale_in_progress"]);
    for (const status of ["draft", "sent", "approved"]) expect(why(closed({ proposalStatuses: [status] })), `proposta ${status}`).toEqual(["sale_in_progress"]);
    for (const stage of ["proposal", "negotiation", "won"]) expect(why(closed({ opportunityStages: ["qualified", stage] })), `oportunidade ${stage}`).toEqual(["sale_in_progress"]);
    expect(why(closed({ commercialOutcome: "vendeu" }))).toEqual(["sale_in_progress"]);
    expect(saleInProgress(closed({ contractStatuses: ["draft"] }))).toBe(true);
  });
  it("não bloqueiam: contrato cancelado (distrato), proposta rejected/expired, oportunidade lost/new/qualified", () => {
    expect(evaluateNonBuyerEligibility(closed({ contractStatuses: ["cancelled"], proposalStatuses: ["rejected", "expired"], opportunityStages: ["lost", "new", "qualified"] })).eligible).toBe(true);
    // um contrato cancelado ao lado de um ativo continua bloqueando
    expect(why(closed({ contractStatuses: ["cancelled", "active"] }))).toEqual(["sale_in_progress"]);
  });
  it("anonimizado (ficha ou cliente), exclusão pendente e opt-out tiram o casal; motivos acumulam", () => {
    expect(why(closed({ captureAnonymized: true }))).toEqual(["anonymized"]);
    expect(why(closed({ customerAnonymized: true }))).toEqual(["anonymized"]);
    expect(why(closed({ erasurePending: true }))).toEqual(["erasure"]);
    expect(why(closed({ optedOut: true }))).toEqual(["opt_out"]);
    expect(why(closed({ optedOut: true, contractStatuses: ["active"], erasurePending: true }))).toEqual(["erasure", "opt_out", "sale_in_progress"]);
  });
  it("sem gate de ciente nem de canal: a ficha é o consentimento (decisão do Lucas) e o módulo não armazena ciente", () => {
    const source = readFileSync(path.resolve(__dirname, "nonBuyerEligibility.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/ciente|acknowledg|channels|noticeVersion|consent/i);
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
  });
  it("a flag RECOVERY_ELIGIBILITY_ENABLED nasce desligada (env, exemplo e compose)", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).toMatch(/^RECOVERY_ELIGIBILITY_ENABLED=false/m);
    expect(readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8")).toContain('RECOVERY_ELIGIBILITY_ENABLED: "${RECOVERY_ELIGIBILITY_ENABLED:-false}"');
    expect(readFileSync(path.join(root, "server/_core/env.ts"), "utf8")).toContain('recoveryEligibilityEnabled: process.env.RECOVERY_ELIGIBILITY_ENABLED === "true"');
  });
});
