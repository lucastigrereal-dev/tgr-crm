import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
import { getDb } from "./db";
import { appRouter } from "./routers";

const mockedGetDb = vi.mocked(getDb);

function context(): TrpcContext {
  return { user: { id: 9, openId: "ops", email: "ops@example.com", name: "Operações", loginMethod: "test", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: { clearCookie: () => undefined } as TrpcContext["res"] };
}

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) promise[method] = () => promise;
  return promise;
}

describe("dashboard.operationalPulse", () => {
  beforeEach(() => vi.resetAllMocks());

  it("materializa exceções e adoção a partir de todas as fontes do data mart operacional", async () => {
    const sourceRows = [
      [{ installment: { id: 1, dueDate: new Date("2020-01-01T12:00:00Z"), status: "overdue", amount: "120.00" }, customerName: "Ana", contractNumber: "CTR-1" }],
      [{ task: { id: 2, title: "Retornar ligação", dueAt: new Date("2020-01-01T12:00:00Z"), status: "open" }, customerName: "Ana" }],
      [{ id: 3, unitId: 7, startsAt: new Date("2020-01-01T12:00:00Z"), status: "active" }],
      [{ item: { id: 4, expiresAt: new Date("2020-01-01T12:00:00Z"), status: "offered" }, customerName: "Bruno" }],
      [{ actorUserId: 9 }, { actorUserId: 11 }],
      [{ id: 99 }, { id: 100 }],
      [], [], [], [],
      [{ contract: { id: 10, number: "CTR-DOC", status: "active" }, customerName: "Catarina", resortId: 2, captureCreatedAt: new Date("2026-08-01T12:00:00Z") }],
      [{ contractId: 10, category: "Contrato assinado" }],
      [{ resortId: 2, requiredContractDocuments: '["Contrato assinado", "RG / CPF"]' }],
      [{ id: 80, promoterId: 20, qualifierId: null, linerId: null, closerId: null, roomManagerId: null, createdAt: new Date("2020-01-01T12:00:00Z"), qualificationStatus: "pending", checkedInAt: null, presentationStartedAt: null, presentationEndedAt: null, assignedAt: null }],
      [{ id: 20, name: "Carlos Captador", email: "carlos@example.com" }],
    ];
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sourceRows.shift() ?? [])) } as never);
    const pulse = await appRouter.createCaller(context()).dashboard.operationalPulse();
    expect(pulse.exceptions.map(item => item.id)).toEqual(expect.arrayContaining(["installment-1", "maintenance-3", "task-2", "waitlist-4", "integrity-10", "rhythm-20"]));
    expect(pulse.exceptions.find(item => item.id === "integrity-10")).toEqual(expect.objectContaining({ responsible: "Contratos", description: expect.stringContaining("RG / CPF") }));
    expect(pulse.exceptions.find(item => item.id === "rhythm-20")).toEqual(expect.objectContaining({ module: "sales", severity: "critical", responsible: "Gerência comercial", title: expect.stringContaining("Carlos Captador"), description: expect.stringContaining("Captação registrada") }));
    expect(pulse.adoption).toEqual({ eventsLast30Days: 2, activeOperators: 2, interactionsLast30Days: 2 });
  });
});
