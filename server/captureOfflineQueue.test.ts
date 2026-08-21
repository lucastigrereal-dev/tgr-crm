import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { captureDedupeKey, enqueueOfflineCapture, listOfflineCaptures, markOfflineCaptureFailed, markOfflineCaptureSyncing, removeOfflineCapture, updateOfflineCapture } from "../client/src/lib/captureOfflineQueue";

describe("capture offline queue", () => {
  beforeEach(async () => {
    for (const item of await listOfflineCaptures()) await removeOfflineCapture(item.id);
  });

  it("gera chave estável para impedir duplicidade da mesma ficha", () => {
    const first = captureDedupeKey({ customer: { fullName: " Ana Souza ", phone: "11999990000" }, resortId: 3, scheduledAt: "2026-08-21T14:00:00.000Z" });
    const duplicate = captureDedupeKey({ customer: { fullName: "ana souza", phone: "11999990000" }, resortId: 3, scheduledAt: "2026-08-21T14:00:00.000Z" });
    const anotherSlot = captureDedupeKey({ customer: { fullName: "ana souza", phone: "11999990000" }, resortId: 3, scheduledAt: "2026-08-21T15:00:00.000Z" });
    expect(first).toBe(duplicate);
    expect(first).not.toBe(anotherSlot);
  });

  it("persiste uma ficha, reaproveita duplicata e remove após sincronização", async () => {
    const payload = { customer: { fullName: "Ana Souza", phone: "11999990000" }, resortId: 3, scheduledAt: "2026-08-21T14:00:00.000Z" };
    const first = await enqueueOfflineCapture(payload);
    const duplicate = await enqueueOfflineCapture(payload);
    expect(duplicate.id).toBe(first.id);
    expect(await listOfflineCaptures()).toHaveLength(1);
    await removeOfflineCapture(first.id);
    expect(await listOfflineCaptures()).toEqual([]);
  });

  it("mantém o conflito explícito até a fila ser revisada", async () => {
    const item = await enqueueOfflineCapture({ customer: { fullName: "Casal em conflito" }, resortId: 9 });
    await markOfflineCaptureFailed(item.id, "Telefone já associado a uma ficha revisada");
    const [pending] = await listOfflineCaptures();
    expect(pending.attempts).toBe(1);
    expect(pending.lastError).toContain("Telefone");
    expect(pending.syncStatus).toBe("conflict");
  });

  it("revisa conflito, preserva a ficha e devolve-a para envio pendente", async () => {
    const item = await enqueueOfflineCapture({ customer: { fullName: "Casal antigo" }, resortId: 9 });
    await markOfflineCaptureSyncing(item.id);
    expect((await listOfflineCaptures())[0].syncStatus).toBe("syncing");
    await markOfflineCaptureFailed(item.id, "Documento já usado");
    await updateOfflineCapture(item.id, { customer: { fullName: "Casal corrigido" }, resortId: 9 });
    const [revised] = await listOfflineCaptures();
    expect((revised.payload.customer as { fullName: string }).fullName).toBe("Casal corrigido");
    expect(revised.syncStatus).toBe("pending");
    expect(revised.lastError).toBeUndefined();
  });
});
