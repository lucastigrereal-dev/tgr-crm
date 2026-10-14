import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, csvImportBatches, csvImportItems, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Gate 2 da migração (TSE #22): o lote guarda sistema e arquivo de origem e o hash do conteúdo; cada item guarda a linha, a chave
// do registro na origem e o hash da linha. Reimportar o mesmo arquivo é avisado (mesmo conteúdo de um lote anterior), sem bloquear.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("importação em MySQL real: origem e hash do lote", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let importsRouter: typeof import("./routers/imports")["importsRouter"];
  let adminId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ importsRouter } = await import("./routers/imports"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `import-prov-${runId}`, name: "Admin importação", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("grava origem, arquivo e hash no lote e linha, chave e hash em cada item; o mesmo arquivo de novo é marcado como repetido", async () => {
    const caller = importsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
    const docA = `9${Date.now()}`.slice(0, 11);
    const docB = `8${Date.now()}`.slice(0, 11);
    const csv = ["nome_completo;documento;status", `Associado Sintético A ${runId};${docA};prospect`, `Associado Sintético B ${runId};${docB};ativo`].join("\n");

    const preview = await caller.preview({ kind: "customers", csv });
    expect(preview.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.duplicateOfBatchId).toBeNull();

    const first = await caller.commit({ kind: "customers", csv, sourceSystem: "tse", sourceFileName: `associados-${runId}.csv` });
    expect(first).toMatchObject({ committed: true, created: 2, contentHash: preview.contentHash, duplicateOfBatchId: null });
    const [batch] = await db.select().from(csvImportBatches).where(eq(csvImportBatches.id, first.batchId!));
    expect(batch).toMatchObject({ sourceSystem: "tse", sourceFileName: `associados-${runId}.csv`, contentHash: preview.contentHash });
    const items = await db.select().from(csvImportItems).where(eq(csvImportItems.batchId, first.batchId!));
    expect(items.map(item => [item.sourceLine, item.sourceRecordId]).sort()).toEqual([[2, docA], [3, docB]]);
    for (const item of items) expect(item.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(items.map(item => item.rowHash)).size).toBe(2);

    const second = await caller.commit({ kind: "customers", csv });
    expect(second).toMatchObject({ committed: true, created: 0, updated: 2, duplicateOfBatchId: first.batchId });
    const [batch2] = await db.select().from(csvImportBatches).where(eq(csvImportBatches.id, second.batchId!));
    expect(batch2).toMatchObject({ sourceSystem: "csv_manual", sourceFileName: null, contentHash: preview.contentHash });
    const items2 = await db.select().from(csvImportItems).where(eq(csvImportItems.batchId, second.batchId!));
    expect(items2.map(item => item.rowHash).sort()).toEqual(items.map(item => item.rowHash).sort()); // mesma linha, mesmo hash
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "csv_import"), eq(auditLogs.entityId, String(second.batchId))));
    expect(audit?.summary).toContain(`mesmo conteúdo do lote ${first.batchId}`);
  });

  it("sistema de origem fora do formato é recusado antes de abrir o lote", async () => {
    const caller = importsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
    await expect(caller.commit({ kind: "customers", csv: "nome_completo;documento\nFulano Sintético;123", sourceSystem: "tse; drop" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
