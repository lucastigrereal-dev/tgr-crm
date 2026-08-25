import { beforeEach, describe, expect, it, vi } from "vitest";
import { customers } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { customersRouter } from "./routers/customers";

function makeDb(options: { existingId?: number | null; duplicateDocumentId?: number } = {}) {
  let customerSelectCall = 0;
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table !== customers) throw new Error("Tabela não prevista neste teste");
        return { where: () => ({ limit: async () => {
          if (options.existingId === null) return [];
          if (options.duplicateDocumentId && customerSelectCall++ > 0) return [{ id: options.duplicateDocumentId }];
          customerSelectCall += 1;
          return [{ id: options.existingId ?? 121 }];
        } }) };
      },
    })),
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

  it("bloqueia documento duplicado e cliente inexistente antes da escrita", async () => {
    const duplicate = makeDb();
    dbMocks.getDb.mockResolvedValue(duplicate);
    await expect(caller().create({ fullName: "Cliente Duplicado", documentNumber: "CPF-123", status: "prospect" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(duplicate.insert).not.toHaveBeenCalled();

    const missing = makeDb({ existingId: null });
    dbMocks.getDb.mockResolvedValue(missing);
    await expect(caller().update({ id: 999, data: { fullName: "Cliente Ausente", status: "prospect" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.update).not.toHaveBeenCalled();

    const updateDuplicate = makeDb({ duplicateDocumentId: 122 });
    dbMocks.getDb.mockResolvedValue(updateDuplicate);
    await expect(caller().update({ id: 121, data: { fullName: "Ana da Silva", documentNumber: "CPF-999", status: "active" } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(updateDuplicate.update).not.toHaveBeenCalled();
  });

  it("bloqueia interação e upload quando o cliente não existe", async () => {
    const missing = makeDb({ existingId: null });
    dbMocks.getDb.mockResolvedValue(missing);
    await expect(caller().addInteraction({ customerId: 999, type: "note", content: "Não deve gravar." })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().uploadDocument({ customerId: 999, category: "Identidade", filename: "rg.pdf", contentType: "application/pdf", base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.insert).not.toHaveBeenCalled();
    expect(storageMocks.storagePut).not.toHaveBeenCalled();
  });

  it("registra evento de interação e de documento com o associado e ator corretos", async () => {
    await caller().addInteraction({ customerId: 88, type: "whatsapp", direction: "outgoing", content: "Contato feito." });
    await caller().uploadDocument({ customerId: 88, category: "Identidade", filename: "rg.pdf", contentType: "application/pdf", base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.interaction.created", aggregateType: "customer_interaction", aggregateId: 121, actorUserId: 44, payload: { customerId: 88, type: "whatsapp", direction: "outgoing" } }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "customer.document.uploaded", aggregateType: "customer_document", aggregateId: 121, actorUserId: 44, payload: { customerId: 88, category: "Identidade", filename: "rg.pdf" } }));
  });
});
