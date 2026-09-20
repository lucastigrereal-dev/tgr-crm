import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { syncRevenueQualityForContract } from "./revenueQualitySync";

describe("revenue quality sync errors", () => {
  it("normaliza banco indisponível sem expor detalhe interno", async () => {
    dbMocks.getDb.mockResolvedValue(null);

    await expect(syncRevenueQualityForContract({ contractId: 44, actorUserId: null, trigger: "teste" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Não foi possível sincronizar a qualidade de receita.",
    });
  });
});
