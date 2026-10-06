import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { capabilityMatrix, type Capability } from "./permissions";


// KAN-31: matriz papel x ação crítica exercitada nos routers reais (sem banco).
// Papel negado => FORBIDDEN. Papel permitido => qualquer coisa exceto FORBIDDEN (sem banco: INTERNAL/NOT_FOUND).
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

// Gabarito da política (fixado aqui de propósito: mudar a matriz sem mudar este teste deve quebrar).
const ACTIONS: Array<{ name: string; capability: Capability; allowed: Role[]; call: (c: Caller) => Promise<unknown> }> = [
  // ADR-002 + correção canônica (Jira KAN-31 #10176): finance/service/seller SOLICITAM; só admin (papel superior) decide e executa.
  { name: "contracts.requestCancellation", capability: "contract.cancel.request", allowed: ["admin", "seller", "finance", "service"], call: c => c.contracts.requestCancellation({ contractId: 1, reason: "SYN motivo" }) },
  { name: "contracts.decideCancellation", capability: "contract.cancel.decide", allowed: ["admin"], call: c => c.contracts.decideCancellation({ requestId: 1, decision: "approved" }) },
  { name: "contracts.executeCancellation", capability: "contract.cancel.execute", allowed: ["admin"], call: c => c.contracts.executeCancellation({ requestId: 1 }) },
  // PRD Apêndice B #11: ativação do contrato é registro da administração (seller passava antes).
  { name: "contracts.updateStatus(active)", capability: "contract.activate", allowed: ["admin"], call: c => c.contracts.updateStatus({ id: 1, status: "active" }) },
  { name: "contracts.create(active)", capability: "contract.activate", allowed: ["admin"], call: c => c.contracts.create({ number: "SYN-RBAC-1", customerId: 1, status: "active", totalAmount: 1000, firstDueDate: "2026-11-01", installmentCount: 1 }) },
  { name: "contracts.markDocumentSigned", capability: "document.sign", allowed: ["admin"], call: c => c.contracts.markDocumentSigned({ documentId: 1 }) },
  { name: "electronicSignatures.start", capability: "document.sign", allowed: ["admin"], call: c => c.electronicSignatures.start({ contractId: 1, contractDocumentId: 1 }) },
  { name: "electronicSignatures.reconcile", capability: "document.sign", allowed: ["admin"], call: c => c.electronicSignatures.reconcile({ envelopeId: 1 }) },
  { name: "finance.createEntry", capability: "finance.entry.create", allowed: ["admin", "finance"], call: c => c.finance.createEntry({ type: "income", category: "SYN", description: "SYN lançamento", amount: 1 }) },
  { name: "finance.reconcileEntry", capability: "finance.payment.reconcile", allowed: ["admin", "finance"], call: c => c.finance.reconcileEntry({ id: 1, reconciliationReference: "SYN-REF" }) },
  { name: "finance.createTransfer", capability: "finance.transfer.create", allowed: ["admin", "finance"], call: c => c.finance.createTransfer({ beneficiaryName: "SYN Beneficiário", amount: 1, dueDate: "2026-12-01" }) },
  { name: "finance.markTransferPaid", capability: "finance.transfer.pay", allowed: ["admin", "finance"], call: c => c.finance.markTransferPaid({ id: 1 }) },
  { name: "commissions.setStatus", capability: "commission.pay", allowed: ["admin", "finance"], call: c => c.commissions.setStatus({ id: 1, status: "paid" }) },
];

// Sem divergências conhecidas: a matriz é a fonte e o router a aplica (decisão de 2026-10-04, ADR-002).
const KNOWN_STRICTER: Record<string, Role[]> = {};

async function outcome(promise: Promise<unknown>) {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "ERROR";
  }
}

describe("matriz RBAC papel x ação crítica (routers reais)", () => {
  for (const action of ACTIONS) {
    it(`${action.name} respeita ${action.capability}`, async () => {
      const matrix = (capabilityMatrix[action.capability] as readonly string[]).filter(r => !(KNOWN_STRICTER[action.name] ?? []).includes(r as Role));
      expect([...matrix].sort(), "capabilityMatrix divergiu do gabarito").toEqual([...action.allowed].sort());
      const allowed: string[] = action.allowed;
      for (const role of ROLES) {
        const result = await outcome(action.call(callerFor(role)));
        if (allowed.includes(role)) expect(result, `${role} deveria passar do RBAC`).not.toBe("FORBIDDEN");
        else expect(result, `${role} deveria ser FORBIDDEN`).toBe("FORBIDDEN");
      }
    });
  }

  it("só administração decide desconto (adminProcedure)", async () => {
    for (const role of ROLES) {
      const result = await outcome(callerFor(role).sales.decideDiscount({ id: 1, approve: true }));
      if (role === "admin") expect(result).not.toBe("FORBIDDEN");
      else expect(result).toBe("FORBIDDEN");
    }
  });
});
