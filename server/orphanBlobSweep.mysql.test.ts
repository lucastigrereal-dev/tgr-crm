import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { contractDocuments, contracts, customerDocuments, customers } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-A07 em MySQL real: arquivo órfão (sem linha em customer_documents/contract_documents) é achado e, só com a exclusão ligada e
// passada a idade mínima, apagado. Arquivo com linha, arquivo recente (upload em andamento) e link simbólico nunca são tocados.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const HOUR = 3_600_000;

describe.skipIf(!integrationUrl)("varredura de blob órfão em MySQL real (CRM-A07)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let dir = "";
  let outside = "";
  let sweep: typeof import("./orphanBlobSweep")["sweepOrphanBlobs"];
  const previousEnv = { ...process.env };

  async function put(key: string, ageHours: number) {
    const target = path.join(dir, ...key.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "conteudo sintetico");
    const when = new Date(Date.now() - ageHours * HOUR);
    await utimes(target, when, when);
    return target;
  }

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    dir = await mkdtemp(path.join(os.tmpdir(), "tgr-orphan-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "tgr-orphan-outside-"));
    process.env.LOCAL_STORAGE_DIRECTORY = dir;
    ({ sweepOrphanBlobs: sweep } = await import("./orphanBlobSweep"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

  it("acha só o que não tem linha; ensaio não apaga; com a exclusão ligada apaga o órfão antigo e poupa o referenciado, o recente e o link simbólico", async () => {
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Cliente órfão ${runId}`, status: "active" }).$returningId();
    const [{ id: contractId }] = await db.insert(contracts).values({ number: `ORF-${runId}`, customerId, status: "draft", totalAmount: "1000.00" } as never).$returningId();
    const keyCustomerDoc = `customers/${customerId}/100-rg_${runId}.pdf`;
    const keyContractDoc = `contracts/${contractId}/100-contrato_${runId}.pdf`;
    const orphanCustomer = `customers/${customerId}/200-perdido_${runId}.pdf`;
    const orphanContract = `contracts/${contractId}/200-perdido_${runId}.pdf`;
    const youngOrphan = `customers/${customerId}/300-em-andamento_${runId}.pdf`;
    const elsewhere = `outros/${runId}/fora-do-escopo.pdf`;
    await put(keyCustomerDoc, 100); await put(keyContractDoc, 100); await put(orphanCustomer, 48); await put(orphanContract, 30); await put(youngOrphan, 1); await put(elsewhere, 500);
    await symlink(path.join(outside, "alvo.txt"), path.join(dir, "customers", String(customerId), `link_${runId}`));
    await writeFile(path.join(outside, "alvo.txt"), "fora da raiz");
    await db.insert(customerDocuments).values({ customerId, type: "RG", filename: "rg.pdf", storageKey: keyCustomerDoc });
    await db.insert(contractDocuments).values({ contractId, category: "Contrato", filename: "c.pdf", storageKey: keyContractDoc });

    // Ensaio (exclusão desligada): relata os dois órfãos antigos e não apaga nada.
    const dry = await sweep({ minAgeHours: 24, deleteOrphans: false });
    expect(dry).toMatchObject({ supported: true, dryRun: true, deleted: 0, failed: 0 });
    if (!dry.supported) throw new Error("esperava suportado");
    expect(dry.orphans).toEqual(expect.arrayContaining([orphanCustomer, orphanContract]));
    expect(dry.orphans).not.toContain(keyCustomerDoc);
    expect(dry.orphans).not.toContain(keyContractDoc);
    expect(dry.orphans).not.toContain(youngOrphan); // mais novo que 24 h
    expect(dry.orphans).not.toContain(elsewhere); // fora de customers/ e contracts/
    expect(dry.orphans.some(key => key.includes("link_"))).toBe(false); // link simbólico não é seguido
    expect(existsSync(path.join(dir, orphanCustomer))).toBe(true);

    const real = await sweep({ minAgeHours: 24, deleteOrphans: true });
    expect(real).toMatchObject({ supported: true, dryRun: false, failed: 0 });
    if (!real.supported) throw new Error("esperava suportado");
    expect(real.deleted).toBe(real.orphans.length);
    expect(existsSync(path.join(dir, orphanCustomer))).toBe(false);
    expect(existsSync(path.join(dir, orphanContract))).toBe(false);
    for (const kept of [keyCustomerDoc, keyContractDoc, youngOrphan, elsewhere]) expect(existsSync(path.join(dir, kept))).toBe(true);
    expect(existsSync(path.join(outside, "alvo.txt"))).toBe(true);

    // Idade mínima menor pega o recente; segunda rodada não acha mais nada dos antigos (idempotente).
    const again = await sweep({ minAgeHours: 24, deleteOrphans: true });
    expect(again.supported && again.orphans.includes(orphanCustomer)).toBe(false);
    const young = await sweep({ minAgeHours: 1, deleteOrphans: true, now: new Date(Date.now() + 2 * HOUR) });
    expect(young.supported && young.orphans.includes(youngOrphan)).toBe(true);
    expect(existsSync(path.join(dir, youngOrphan))).toBe(false);
    expect(existsSync(path.join(dir, keyCustomerDoc))).toBe(true);
  });

  it("sem armazenamento local (storage remoto) não faz nada e diz que não é suportado", async () => {
    const saved = process.env.LOCAL_STORAGE_DIRECTORY;
    delete process.env.LOCAL_STORAGE_DIRECTORY;
    try { expect(await sweep({ minAgeHours: 24, deleteOrphans: true })).toMatchObject({ supported: false }); }
    finally { process.env.LOCAL_STORAGE_DIRECTORY = saved; }
  });
});
