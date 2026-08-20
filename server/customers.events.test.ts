import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { customersRouter } from "./routers/customers";

function makeDb() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 121 }] })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
}

function caller() {
  return customersRouter.createCaller({ user: { id: 44, role: "admin" } } as never);
}

describe("eventos e auditoria de associados", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDb.mockResolvedValue(makeDb());
    storageMocks.storagePut.mockResolvedValue({ key: "customers/1/documento.pdf", url: "https://storage.example/documento.pdf" });
  });

  it("registra auditoria e evento ao criar e atualizar associado", async () => {
    await caller().create({ fullName: "Ana da Silva", status: "active", acquisitionSource: "tour" });
    await caller().update({ id: 121, data: { fullName: "Ana da Silva", status: "inactive", city: "Olímpia", state: "SP" } });

    expect(dbMocks.recordAudit).toHaveBeenCalledWith(44, "customer", 121, "created", expect.stringContaining("Ana da Silva"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.created", aggregateType: "customer", aggregateId: 121, actorUserId: 44, payload: expect.objectContaining({ status: "active", acquisitionSource: "tour" }) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(44, "customer", 121, "updated", expect.stringContaining("Ana da Silva"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.updated", aggregateType: "customer", aggregateId: 121, actorUserId: 44, payload: expect.objectContaining({ status: "inactive", city: "Olímpia", state: "SP" }) }));
  });

  it("registra evento de interação e de documento com o associado e ator corretos", async () => {
    await caller().addInteraction({ customerId: 88, type: "whatsapp", direction: "outgoing", content: "Contato feito." });
    await caller().uploadDocument({ customerId: 88, category: "Identidade", filename: "rg.pdf", contentType: "application/pdf", base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.interaction.created", aggregateType: "customer_interaction", aggregateId: 121, actorUserId: 44, payload: { customerId: 88, type: "whatsapp", direction: "outgoing" } }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.document.uploaded", aggregateType: "customer_document", aggregateId: 121, actorUserId: 44, payload: { customerId: 88, category: "Identidade", filename: "rg.pdf" } }));
  });
});
