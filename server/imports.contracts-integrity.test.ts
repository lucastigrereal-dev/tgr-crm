import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contracts, customers, users } from "../drizzle/schema";
import { importsRouter } from "./routers/imports";

function makeDb() {
  const transaction = vi.fn();
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => table === customers ? [{ id: 10, documentNumber: "12345678900" }] : table === users ? [{ id: 20, email: "finance@example.com", role: "finance" }] : table === contracts ? [] : []),
      })),
    })),
    transaction,
  };
  return { db, transaction };
}

describe("integridade do importador de contratos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita seller por e-mail com papel incompatível antes de abrir o lote", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = importsRouter.createCaller({ user: { id: 9, role: "admin" } } as never);
    const csv = [
      "numero_contrato;documento_associado;modelo_uso;status;valor_total;quantidade_parcelas;primeiro_vencimento;email_vendedor",
      "CT-2026-001;12345678900;semana_flexivel;ativo;12500;12;2026-09-10;finance@example.com",
    ].join("\n");

    const result = await caller.commit({ kind: "contracts", csv });

    expect(result).toMatchObject({ valid: false, committed: false, totalRows: 1, created: 0, updated: 0 });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: "email_vendedor" })]));
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
