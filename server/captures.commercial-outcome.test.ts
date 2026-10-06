import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-007 (V6): resultado comercial da sala (VENDEU / CAIU EM MESA) pelo closer ou admin; imutável; não é venda validada.
vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { captureRecords } from "../drizzle/schema";
import { appRouter } from "./routers";

const mockedDb = vi.mocked(getDb);
function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}
const caller = (role: string, id = 17) => appRouter.createCaller({ user: { id, role } } as never);
const capture = (overrides: Record<string, unknown> = {}) => ({ id: 91, closerId: 17, presentationStatus: "presented", commercialOutcome: null, commercialOutcomeReason: null, ...overrides });

function fixture(rows: Array<Record<string, unknown>>, affected = 1) {
  const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ affectedRows: affected }) }));
  const update = vi.fn(() => ({ set }));
  const insert = vi.fn();
  const select = vi.fn();
  rows.forEach(row => select.mockReturnValueOnce(chain([row])));
  select.mockReturnValue(chain([rows[rows.length - 1]]));
  mockedDb.mockResolvedValue({ select, update, insert } as never);
  return { update, set, insert };
}

describe("captures.recordCommercialOutcome", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["service", "finance", "user"])("papel %s é FORBIDDEN sem tocar o banco", async role => {
    await expect(caller(role).captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedDb).not.toHaveBeenCalled();
  });

  it("seller que não é o closer designado é FORBIDDEN; nada é gravado", async () => {
    const f = fixture([capture({ closerId: 99 })]);
    await expect(caller("seller", 17).captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.update).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("VENDEU pelo closer: grava resultado, audita e emite evento sem motivo; não toca oportunidade/contrato/comissão", async () => {
    const f = fixture([capture()]);
    await expect(caller("seller", 17).captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).resolves.toMatchObject({ success: true, alreadyRecorded: false, outcome: "vendeu" });
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith(captureRecords);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.set).toHaveBeenCalledWith(expect.objectContaining({ commercialOutcome: "vendeu", commercialOutcomeReason: null, commercialOutcomeAt: expect.any(Date), commercialOutcomeByUserId: 17 }));
    expect(recordAudit).toHaveBeenCalledWith(17, "capture", 91, "commercial_outcome_recorded", expect.stringContaining("VENDEU"));
    expect(recordDomainEvent).toHaveBeenCalledWith({ eventName: "capture.commercial_outcome.recorded", aggregateType: "capture", aggregateId: 91, actorUserId: 17, payload: { outcome: "vendeu" } });
  });

  it("CAIU EM MESA pelo admin com motivo: evento leva o motivo; sem efeitos de venda", async () => {
    const f = fixture([capture({ closerId: 5 })]);
    await expect(caller("admin", 1).captures.recordCommercialOutcome({ id: 91, outcome: "caiu_em_mesa", reason: "  Cliente desistiu na mesa  " })).resolves.toMatchObject({ success: true, outcome: "caiu_em_mesa" });
    expect(f.set).toHaveBeenCalledWith(expect.objectContaining({ commercialOutcome: "caiu_em_mesa", commercialOutcomeReason: "Cliente desistiu na mesa", commercialOutcomeByUserId: 1 }));
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.insert).not.toHaveBeenCalled();
    expect(recordDomainEvent).toHaveBeenCalledTimes(1);
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.commercial_outcome.recorded", payload: { outcome: "caiu_em_mesa", reason: "Cliente desistiu na mesa" } }));
  });

  it.each([undefined, null, "", "  ", " ab "])("CAIU EM MESA exige motivo com ≥3 caracteres úteis (%j)", async reason => {
    fixture([capture()]);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "caiu_em_mesa", reason })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it.each(["captured", "scheduled", "checked_in", "no_tour"])("recusa resultado comercial com a ficha em %s (sem apresentação)", async presentationStatus => {
    const f = fixture([capture({ presentationStatus })]);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMERCIAL_OUTCOME_REQUIRES_PRESENTATION") });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("aceita também ficha com apresentação já encerrada (closed): endPresentation segue independente", async () => {
    fixture([capture({ presentationStatus: "closed" })]);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).resolves.toMatchObject({ success: true });
  });

  it("repetição idêntica é idempotente: sem update, sem evento, sem audit", async () => {
    const f = fixture([capture({ commercialOutcome: "caiu_em_mesa", commercialOutcomeReason: "Cliente desistiu" })]);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "caiu_em_mesa", reason: "Cliente desistiu" })).resolves.toMatchObject({ success: true, alreadyRecorded: true });
    expect(f.update).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["resultado diferente", { outcome: "vendeu" as const }],
    ["motivo diferente", { outcome: "caiu_em_mesa" as const, reason: "Outro motivo" }],
  ])("imutável: %s depois de gravado é recusado (CONFLICT)", async (_label, input) => {
    const f = fixture([capture({ commercialOutcome: "caiu_em_mesa", commercialOutcomeReason: "Cliente desistiu" })]);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, ...input })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("COMMERCIAL_OUTCOME_IMMUTABLE") });
    expect(f.update).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("corrida: update condicional perde, releitura idêntica vira idempotente sem evento duplicado", async () => {
    const f = fixture([capture(), capture({ commercialOutcome: "vendeu" })], 0);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).resolves.toMatchObject({ success: true, alreadyRecorded: true });
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("corrida: update condicional perde e o outro resultado é diferente => CONFLICT", async () => {
    fixture([capture(), capture({ commercialOutcome: "caiu_em_mesa", commercialOutcomeReason: "x motivo" })], 0);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 91, outcome: "vendeu" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("ficha inexistente => NOT_FOUND", async () => {
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([])) } as never);
    await expect(caller("admin").captures.recordCommercialOutcome({ id: 404, outcome: "vendeu" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
