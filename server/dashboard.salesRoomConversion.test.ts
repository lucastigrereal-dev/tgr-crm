import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
import { getDb } from "./db";
import { appRouter } from "./routers";

const mockedDb = vi.mocked(getDb);
const caller = (role: string) => appRouter.createCaller({ user: { id: 44, role } } as never);

function database() {
  const captureRows = [
    { capture: { id: 1, createdAt: new Date("2026-08-01T12:00:00Z"), scheduledAt: new Date("2026-08-10T12:00:00Z"), resortId: 3, salesRoom: "Sala A", campaignId: 8, promoterId: 10, linerId: 11, closerId: 12, presentationStatus: "closed", checkedInAt: new Date("2026-08-10T12:05:00Z"), presentationStartedAt: new Date("2026-08-10T12:10:00Z") }, opportunityStage: "won" },
    { capture: { id: 2, createdAt: new Date("2026-08-01T12:00:00Z"), scheduledAt: new Date("2026-08-10T13:00:00Z"), campaignId: 8, promoterId: 10, linerId: null, closerId: null, presentationStatus: "no_tour", checkedInAt: null, presentationStartedAt: null }, opportunityStage: "lost" },
    { capture: { id: 3, createdAt: new Date("2026-08-01T12:00:00Z"), scheduledAt: new Date("2026-07-30T13:00:00Z"), campaignId: 8, promoterId: 10, linerId: 11, closerId: 12, presentationStatus: "closed", checkedInAt: new Date("2026-07-30T13:00:00Z"), presentationStartedAt: new Date("2026-07-30T13:10:00Z") }, opportunityStage: "won" },
  ];
  const select = vi.fn()
    .mockReturnValueOnce({ from: () => ({ leftJoin: async () => captureRows }) })
    .mockReturnValueOnce({ from: async () => [{ id: 8, name: "Campanha Verão" }] })
    .mockReturnValueOnce({ from: async () => [{ id: 10, name: "Paulo Promotor", email: null }, { id: 11, name: "Lia Liner", email: null }, { id: 12, name: "Fábio Fechador", email: null }] })
    .mockReturnValueOnce({ from: () => ({ where: async () => [{ id: 3, name: "Resort Teste" }] }) });
  return { select };
}

describe("dashboard.salesRoomConversion", () => {
  beforeEach(() => vi.resetAllMocks());

  it("entrega conversão do período, com nomes de campanha/equipe e sem-tour separado de tour", async () => {
    mockedDb.mockResolvedValue(database() as never);
    const result = await caller("finance").dashboard.salesRoomConversion({ startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(result.metrics).toMatchObject({ captures: 2, arrivals: 1, presentations: 1, completed: 1, noTours: 1, wins: 1, closeRate: 100, noTourRate: 50 });
    expect(result.breakdowns.campaigns).toEqual([expect.objectContaining({ label: "Campanha Verão", captures: 2 })]);
    expect(result.breakdowns.promoters).toEqual([expect.objectContaining({ label: "Paulo Promotor", wins: 1 })]);
    expect(result.breakdowns.liners).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Lia Liner" }), expect.objectContaining({ label: "Não atribuído", noTours: 1 })]));
  });

  it("recorta a conversão pelo papel comercial e responsável selecionados", async () => {
    mockedDb.mockResolvedValue(database() as never);
    const result = await caller("finance").dashboard.salesRoomConversion({ startDate: "2026-08-01", endDate: "2026-08-31", commercialRole: "liner", operatorId: 11 });
    expect(result.metrics).toMatchObject({ captures: 1, presentations: 1, wins: 1, noTours: 0 });
    expect(result.filters.operators).toEqual(expect.arrayContaining([expect.objectContaining({ id: 11, name: "Lia Liner" })]));
  });

  it("barra perfil externo antes da leitura analítica", async () => {
    await expect(caller("user").dashboard.salesRoomConversion()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedDb).not.toHaveBeenCalled();
  });
});
