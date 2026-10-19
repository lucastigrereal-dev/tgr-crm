import { inArray } from "drizzle-orm";
import { contractDocuments, customerDocuments } from "../drizzle/schema";
import { getDb } from "./db";
import { deleteLocalStorageFile, getLocalStorageRoot, listLocalStorageFiles } from "./localStorage";

/**
 * Varredura de blob órfão (CRM-A07): o upload grava o arquivo no armazenamento ANTES de gravar a linha do documento. Se a gravação
 * da linha falha (ou o processo cai no meio), sobra um arquivo sem dono, com CPF/RG possivelmente dentro. Esta varredura lista o que
 * existe sob `customers/` e `contracts/`, confere cada chave contra `customer_documents` e `contract_documents` e, só com a
 * exclusão ligada, apaga o que não tem linha E é mais velho que a idade mínima (padrão 24 h: protege upload em andamento).
 *
 * Desligada por padrão (ORPHAN_BLOB_SWEEP_ENABLED). Ligada sem ORPHAN_BLOB_SWEEP_DELETE só relata (ensaio). Só cobre o armazenamento
 * LOCAL do piloto: o storage remoto (Forge/S3) não tem listagem nesta camada, então a varredura diz "não suportado" e não faz nada.
 */
export const ORPHAN_SWEEP_PREFIXES = ["customers", "contracts"] as const;

export type OrphanSweepResult =
  | { supported: false; reason: string }
  | { supported: true; scanned: number; referenced: number; tooYoung: number; orphans: string[]; deleted: number; failed: number; orphanBytes: number; dryRun: boolean };

type Options = { minAgeHours: number; deleteOrphans: boolean; now?: Date };

export async function sweepOrphanBlobs(options: Options): Promise<OrphanSweepResult> {
  if (!getLocalStorageRoot()) return { supported: false, reason: "Armazenamento remoto: sem listagem nesta camada. Use o relatório do provedor." };
  const db = await getDb();
  if (!db) return { supported: false, reason: "Banco indisponível." };
  const now = (options.now ?? new Date()).getTime();
  const cutoff = now - Math.max(1, options.minAgeHours) * 3_600_000;
  const files = (await Promise.all(ORPHAN_SWEEP_PREFIXES.map(prefix => listLocalStorageFiles(prefix)))).flat();

  const old = files.filter(file => file.modifiedAt.getTime() <= cutoff);
  const referenced = new Set<string>();
  for (let from = 0; from < old.length; from += 200) {
    const keys = old.slice(from, from + 200).map(file => file.key);
    const [customerRows, contractRows] = await Promise.all([
      db.select({ key: customerDocuments.storageKey }).from(customerDocuments).where(inArray(customerDocuments.storageKey, keys)),
      db.select({ key: contractDocuments.storageKey }).from(contractDocuments).where(inArray(contractDocuments.storageKey, keys)),
    ]);
    for (const row of [...customerRows, ...contractRows]) referenced.add(row.key);
  }
  const orphans = old.filter(file => !referenced.has(file.key));
  let deleted = 0, failed = 0;
  if (options.deleteOrphans) {
    for (const orphan of orphans) {
      try { await deleteLocalStorageFile(orphan.key); deleted += 1; } catch { failed += 1; }
    }
  }
  return { supported: true, scanned: files.length, referenced: referenced.size, tooYoung: files.length - old.length, orphans: orphans.map(file => file.key), deleted, failed, orphanBytes: orphans.reduce((sum, file) => sum + file.sizeBytes, 0), dryRun: !options.deleteOrphans };
}

export type OrphanBlobSweepJob = { stop: () => void; runOnce: () => Promise<OrphanSweepResult | null> };

/** Job periódico (padrão a cada 24 h, e uma vez na subida). Uma rodada em andamento não é sobreposta. Só é criado quando a flag está ligada. */
export function startOrphanBlobSweepJob(options: Options & { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: OrphanSweepResult) => void }): OrphanBlobSweepJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await sweepOrphanBlobs(options);
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 24 * 3_600_000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
