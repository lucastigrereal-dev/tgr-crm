import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { appRouter } from "./routers";

const mockedDb = vi.mocked(getDb);
function chain<T>(value: T) { const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>; for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise; return promise; }
function caller(role: string) { return appRouter.createCaller({ user: { id: 7, role } } as never); }
function returningId(rows: { id: number }[]) { return { values: vi.fn(() => ({ $returningId: vi.fn().mockResolvedValue(rows) })) }; }
const baseInput = { customer: { fullName: "Rafael da Captação", phone: "11999999999", city: "Americana", state: "SP" }, campaignId: 12, captureLocation: "Estacionamento", salesRoom: "Thermas São Pedro", qualificationStatus: "qualified" as const, travelWeeksPerYear: 2, averageIncome: 15000, createOpportunity: true };

describe("captures.create", () => {
  beforeEach(() => vi.resetAllMocks());

  it("barra perfil sem acesso comercial antes de tocar no banco", async () => {
    await expect(caller("user").captures.create(baseInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedDb).not.toHaveBeenCalled();
  });

  it("rejeita campanha inexistente antes de criar qualquer entidade", async () => {
    const select = vi.fn().mockReturnValueOnce(chain([]));
    const insert = vi.fn();
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);

    await expect(caller("seller").captures.create(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(insert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita associado inexistente antes de criar oportunidade ou ficha", async () => {
    const select = vi.fn()
      .mockReturnValueOnce(chain([{ id: 12 }]))
      .mockReturnValueOnce(chain([]));
    const insert = vi.fn();
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);

    await expect(caller("seller").captures.create({ ...baseInput, customerId: 999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(insert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("aborta captação quando a oportunidade não devolve ID persistido", async () => {
    const select = vi.fn()
      .mockReturnValueOnce(chain([{ id: 12 }]))
      .mockReturnValueOnce(chain([]));
    const insert = vi.fn()
      .mockImplementationOnce(() => returningId([{ id: 101 }]))
      .mockImplementationOnce(() => returningId([]));
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);

    await expect(caller("seller").captures.create(baseInput)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("aborta captação quando o follow-up não devolve ID persistido", async () => {
    const select = vi.fn()
      .mockReturnValueOnce(chain([{ id: 12 }]))
      .mockReturnValueOnce(chain([]));
    const insert = vi.fn()
      .mockImplementationOnce(() => returningId([{ id: 101 }]))
      .mockImplementationOnce(() => returningId([{ id: 202 }]))
      .mockImplementationOnce(() => returningId([{ id: 303 }]))
      .mockImplementationOnce(() => returningId([]));
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);

    await expect(caller("seller").captures.create({ ...baseInput, scheduledAt: "2026-08-25T14:30:00.000Z" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(insert).toHaveBeenCalledTimes(4);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("cria associado, oportunidade, ficha e tarefa quando existe agendamento", async () => {
    const select = vi.fn()
      .mockReturnValueOnce(chain([{ id: 12 }]))
      .mockReturnValueOnce(chain([]));
    const insert = vi.fn()
      .mockImplementationOnce(() => returningId([{ id: 101 }]))
      .mockImplementationOnce(() => returningId([{ id: 202 }]))
      .mockImplementationOnce(() => returningId([{ id: 303 }]))
      .mockImplementationOnce(() => returningId([{ id: 404 }]));
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);
    const result = await caller("seller").captures.create({ ...baseInput, scheduledAt: "2026-08-25T14:30:00.000Z" });
    expect(result).toEqual({ customerId: 101, opportunityId: 202, captureId: 303, taskId: 404 });
    expect(insert).toHaveBeenCalledTimes(4);
    expect(insert.mock.results[1]?.value.values).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 12 }));
    expect(insert.mock.results[2]?.value.values).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 12 }));
    expect(recordAudit).toHaveBeenCalledWith(7, "task", 404, "created", expect.any(String));
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.created", aggregateId: 303 }));
  });

  it("reaproveita associado encontrado por telefone sem duplicar cadastro", async () => {
    const select = vi.fn()
      .mockReturnValueOnce(chain([{ id: 12 }]))
      .mockReturnValueOnce(chain([{ id: 55, fullName: "Rafael Existente" }]));
    const insert = vi.fn()
      .mockImplementationOnce(() => returningId([{ id: 66 }]))
      .mockImplementationOnce(() => returningId([{ id: 77 }]));
    mockedDb.mockResolvedValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ select, insert }) } as never);
    const result = await caller("seller").captures.create(baseInput);
    expect(result).toEqual({ customerId: 55, opportunityId: 66, captureId: 77, taskId: null });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
