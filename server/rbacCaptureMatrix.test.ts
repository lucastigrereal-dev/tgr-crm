import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// M-A12-01/M-A12-02: matriz persona x ação da SALA (captação, ficha, check-in, resultado) exercitada nos routers reais, sem banco. A prova é na API, não no menu.
// Persona -> papel interno do CRM (não existe papel "recepção" próprio): gerente de sala/administrativo = admin (ADR-007); consultor/fechador = seller; recepção e pós-vendas = service;
// financeiro = finance; "user" não tem acesso. Papel negado => FORBIDDEN. Papel permitido => qualquer coisa exceto FORBIDDEN (sem banco: erro de infraestrutura).
type Role = "admin" | "seller" | "finance" | "service" | "user";
const ROLES: Role[] = ["admin", "seller", "finance", "service", "user"];

function callerFor(role: Role) {
  const ctx = {
    user: { id: 99, openId: `rbac-${role}`, email: `${role}@example.com`, name: role, loginMethod: "test", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => undefined } as TrpcContext["res"],
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}
type Caller = ReturnType<typeof callerFor>;

const SALA: Role[] = ["admin", "seller"];
const SALA_E_RECEPCAO: Role[] = ["admin", "seller", "service"];
const TODOS_INTERNOS: Role[] = ["admin", "seller", "finance", "service"];

// Gabarito (fixado aqui de propósito: mudar a guarda de uma ação sem mudar este teste deve quebrar).
const ACTIONS: Array<{ name: string; allowed: Role[]; call: (c: Caller) => Promise<unknown> }> = [
  // Recepção (service) localiza fila, faz check-in, atribui mesa e marca NT; cadastrar o casal e registrar resultado comercial ficam com a sala (admin/seller).
  { name: "captures.receptionQueue", allowed: SALA_E_RECEPCAO, call: c => c.captures.receptionQueue({}) },
  { name: "captures.checkIn", allowed: SALA_E_RECEPCAO, call: c => c.captures.checkIn({ id: 1 }) },
  { name: "captures.assignRoom", allowed: SALA_E_RECEPCAO, call: c => c.captures.assignRoom({ id: 1, salesTable: "M1" } as never) },
  { name: "captures.startPresentation", allowed: SALA_E_RECEPCAO, call: c => c.captures.startPresentation({ id: 1 }) },
  { name: "captures.endPresentation", allowed: SALA_E_RECEPCAO, call: c => c.captures.endPresentation({ id: 1 }) },
  { name: "captures.markNoTour", allowed: SALA_E_RECEPCAO, call: c => c.captures.markNoTour({ id: 1, reason: "SYN sem tour" } as never) },
  { name: "captures.list", allowed: SALA, call: c => c.captures.list({}) },
  { name: "captures.updateStatus", allowed: SALA, call: c => c.captures.updateStatus({ id: 1, presentationStatus: "closed" } as never) },
  { name: "captures.recordCommercialOutcome", allowed: SALA, call: c => c.captures.recordCommercialOutcome({ id: 1, outcome: "vendeu" } as never) },
  // Ficha: ligar o código (capacidade capture.couple_code.link; padrão admin+seller), registrar NT e editar extras; recepção imprime, coleta e vê pendentes.
  { name: "captureSheet.setCoupleCode", allowed: SALA, call: c => c.captureSheet.setCoupleCode({ captureId: 1, coupleCode: "SYN-RBAC-1" }) },
  { name: "captureSheet.unlinked", allowed: SALA_E_RECEPCAO, call: c => c.captureSheet.unlinked() },
  { name: "captureSheet.recordPrint", allowed: SALA_E_RECEPCAO, call: c => c.captureSheet.recordPrint({ code: "SYN-RBAC-1" }) },
  { name: "captureSheet.recordNt", allowed: SALA, call: c => c.captureSheet.recordNt({ captureId: 1, motiveId: 1 } as never) },
  { name: "captureSheet.today", allowed: TODOS_INTERNOS, call: c => c.captureSheet.today() },
];

async function outcome(promise: Promise<unknown>) {
  try { await promise; return "OK"; } catch (error) { return (error as { code?: string }).code ?? "ERROR"; }
}

describe("matriz RBAC persona x ação da sala (routers reais, sem banco)", () => {
  for (const action of ACTIONS) {
    it(`${action.name}: ${action.allowed.join("+")} passam; os demais, FORBIDDEN`, async () => {
      for (const role of ROLES) {
        const result = await outcome(action.call(callerFor(role)));
        if (action.allowed.includes(role)) expect(result, `${role} deveria passar do RBAC`).not.toBe("FORBIDDEN");
        else expect(result, `${role} deveria ser FORBIDDEN`).toBe("FORBIDDEN");
      }
    });
  }

  it("recepção (service) nunca valida venda, paga comissão, decide/executa distrato nem lança no financeiro (prova de negativa na API)", async () => {
    const recepcao = callerFor("service");
    const calls: Array<[string, Promise<unknown>]> = [
      ["saleValidation.validateSale", recepcao.saleValidation.validateSale({ contractId: 1 })],
      ["saleValidation.confirmPayment", recepcao.saleValidation.confirmPayment({ contractId: 1, note: "SYN" })],
      ["commissions.setStatus", recepcao.commissions.setStatus({ id: 1, status: "paid" })],
      ["contracts.decideCancellation", recepcao.contracts.decideCancellation({ requestId: 1, decision: "approved" })],
      ["contracts.executeCancellation", recepcao.contracts.executeCancellation({ requestId: 1 })],
      ["finance.createEntry", recepcao.finance.createEntry({ type: "income", category: "SYN", description: "SYN", amount: 1 })],
      ["inventory.sweepExpiredHolds", recepcao.inventory.sweepExpiredHolds()],
      ["contracts.openCancellationFromInbox", recepcao.contracts.openCancellationFromInbox({ protocol: "00000000-0000-4000-8000-000000000000" }).catch(error => { if ((error as { code?: string }).code === "FORBIDDEN") throw error; return "ok-rbac"; })],
    ];
    for (const [name, call] of calls) {
      if (name === "contracts.openCancellationFromInbox") { expect(await outcome(call), name).not.toBe("FORBIDDEN"); continue; } // pedir distrato é amplo (ADR-002); decidir/executar não
      expect(await outcome(call), name).toBe("FORBIDDEN");
    }
  });
});
