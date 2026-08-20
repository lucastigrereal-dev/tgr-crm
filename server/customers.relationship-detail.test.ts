import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => ({ storagePut: vi.fn() }));

import { customersRouter } from "./routers/customers";

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin"]) promise[method] = () => promise;
  return promise;
}

describe("contrato da central de relacionamento", () => {
  it("entrega radar, onboarding e tarefas abertas junto com a ficha do associado", async () => {
    const results = [
      [{ id: 9, fullName: "Ana", email: "ana@exemplo.com", phone: "11999999999", status: "active" }],
      [{ id: 1, occurredAt: new Date("2026-08-16T12:00:00Z") }],
      [{ id: 2 }],
      [{ id: 3, status: "active" }],
      [],
      [{ id: 4, checkIn: new Date("2026-09-10T12:00:00Z") }],
      [{ status: "open" }],
      [{ id: 7, title: "Ligar para confirmar reserva", status: "open", dueAt: new Date("2026-08-21T12:00:00Z") }],
    ];
    const db = { select: vi.fn(() => chain(results.shift() ?? [])) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = customersRouter.createCaller({ user: { id: 2, role: "service" } } as never);

    const detail = await caller.detail({ id: 9 });
    expect(detail).toMatchObject({ customer: { id: 9 }, radar: { label: "saudável", score: 100 }, relationshipTasks: [{ id: 7, title: "Ligar para confirmar reserva" }] });
    expect(detail?.radar.onboarding.every(item => item.complete)).toBe(true);
  });
});
