import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Contatos múltiplos do associado (TSE #28) em MySQL real: preferencial único por tipo, espelho no cadastro, sem duplicata.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("contatos múltiplos do associado em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let customerContactsRouter: typeof import("./routers/customerContacts")["customerContactsRouter"];
  let customersRouter: typeof import("./routers/customers")["customersRouter"];
  let importsRouter: typeof import("./routers/imports")["importsRouter"];
  let userId: number;
  let customerId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ customerContactsRouter } = await import("./routers/customerContacts"));
    ({ customersRouter } = await import("./routers/customers"));
    ({ importsRouter } = await import("./routers/imports"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `contacts-${runId}`, name: "Atendente contatos", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Fulano Sintético ${runId}`, phone: "84900000000", email: `antigo-${runId}@example.test`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "seller") => customerContactsRouter.createCaller({ user: { id: userId, role } } as never);
  const customer = async () => (await db.select().from(customers).where(eq(customers.id, customerId)))[0]!;

  it("ficha antiga: o telefone principal entra na lista como preferencial e o novo não o sobrescreve; trocar deixa um preferencial só", async () => {
    const first = await caller().add({ customerId, kind: "phone", value: "(84) 98888-1111", label: "trabalho" });
    expect((await customer()).phone).toBe("84900000000");
    let phones = (await caller().list({ customerId })).filter(row => row.kind === "phone");
    expect(phones.map(row => [row.value, row.isPreferred])).toEqual([["84900000000", true], ["(84) 98888-1111", false]]);
    const second = await caller().add({ customerId, kind: "phone", value: "+55 84 97777-2222" });
    await caller().setPreferred({ contactId: second.contactId });
    phones = (await caller().list({ customerId })).filter(row => row.kind === "phone");
    expect(phones.filter(row => row.isPreferred).map(row => row.id)).toEqual([second.contactId]);
    expect(phones.map(row => row.id)).toContain(first.contactId);
    expect((await customer()).phone).toBe("+55 84 97777-2222");
  });

  it("arquivar o preferencial passa o posto ao contato mais recente; sem nenhum, o principal da ficha fica vazio", async () => {
    const [{ id: lonely }] = await db.insert(customers).values({ fullName: `Beltrano Sintético ${runId}`, status: "active" }).$returningId();
    const a = await caller().add({ customerId: lonely, kind: "phone", value: "84911112222" });
    const b = await caller().add({ customerId: lonely, kind: "phone", value: "84933334444" });
    await caller().archive({ contactId: a.contactId });
    expect((await db.select().from(customers).where(eq(customers.id, lonely)))[0]!.phone).toBe("84933334444");
    expect((await caller().list({ customerId: lonely })).find(row => row.id === b.contactId)?.isPreferred).toBe(true);
    await caller().archive({ contactId: b.contactId });
    expect((await db.select().from(customers).where(eq(customers.id, lonely)))[0]!.phone).toBeNull();
  });

  it("editar o telefone na ficha atualiza o preferencial da lista", async () => {
    const [{ id: edited }] = await db.insert(customers).values({ fullName: `Edita Sintético ${runId}`, phone: "84955556666", status: "active" }).$returningId();
    await caller().add({ customerId: edited, kind: "phone", value: "84977778888" });
    const profile = customersRouter.createCaller({ user: { id: userId, role: "seller" } } as never);
    await profile.update({ id: edited, data: { fullName: `Edita Sintético ${runId}`, status: "active", phone: "84977778888" } });
    let phones = (await caller().list({ customerId: edited })).filter(row => row.kind === "phone");
    expect(phones.filter(row => row.isPreferred).map(row => row.value)).toEqual(["84977778888"]);
    await profile.update({ id: edited, data: { fullName: `Edita Sintético ${runId}`, status: "active", phone: "84999990000" } });
    phones = (await caller().list({ customerId: edited })).filter(row => row.kind === "phone");
    expect(phones.filter(row => row.isPreferred).map(row => row.value)).toEqual(["84999990000"]);
    expect(phones).toHaveLength(3);
  });

  it("importação que regrava o telefone de associado existente atualiza o preferencial da lista", async () => {
    const document = String(Date.now()).slice(-11);
    const [{ id: imported }] = await db.insert(customers).values({ fullName: `Importa Sintético ${runId}`, documentNumber: document, phone: "84912340000", status: "active" }).$returningId();
    await caller().add({ customerId: imported, kind: "phone", value: "84956780000" });
    const admin = importsRouter.createCaller({ user: { id: userId, role: "admin" } } as never);
    const result = await admin.commit({ kind: "customers", csv: `nome_completo;documento;telefone\nImporta Sintético ${runId};${document};84956780000` });
    expect(result.committed).toBe(true);
    const phones = (await caller().list({ customerId: imported })).filter(row => row.kind === "phone");
    expect(phones.filter(row => row.isPreferred).map(row => row.value)).toEqual(["84956780000"]);
  });

  it("mesmo contato com outra máscara é recusado; e-mail inválido e telefone curto também", async () => {
    await expect(caller().add({ customerId, kind: "phone", value: "84 98888 1111" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().add({ customerId, kind: "email", value: "nao-e-email" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().add({ customerId, kind: "whatsapp", value: "1234" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("e-mail preferencial espelha no cadastro; arquivar tira da lista sem apagar e libera recadastro", async () => {
    const email = await caller().add({ customerId, kind: "email", value: `Novo-${runId}@Example.test`, preferred: true });
    expect((await customer()).email).toBe(`novo-${runId}@example.test`);
    await caller().archive({ contactId: email.contactId });
    expect((await caller().list({ customerId })).some(row => row.id === email.contactId)).toBe(false);
    expect((await caller().list({ customerId, includeArchived: true })).find(row => row.id === email.contactId)?.archivedAt).toBeTruthy();
    await expect(caller().archive({ contactId: email.contactId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().setPreferred({ contactId: email.contactId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().add({ customerId, kind: "email", value: `novo-${runId}@example.test` })).resolves.toMatchObject({ contactId: expect.any(Number) });
  });


  it("trocas de preferencial ao mesmo tempo no mesmo associado terminam com um preferencial só, igual ao da ficha", async () => {
    const [{ id: busy }] = await db.insert(customers).values({ fullName: `Ciclano Sintético ${runId}`, status: "active" }).$returningId();
    const ids: number[] = [];
    for (const value of ["84955550001", "84955550002", "84955550003", "84955550004"]) ids.push((await caller().add({ customerId: busy, kind: "phone", value })).contactId);
    const results = await Promise.allSettled([...ids, ...ids].map(contactId => caller().setPreferred({ contactId })));
    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    const phones = (await caller().list({ customerId: busy })).filter(row => row.kind === "phone");
    const preferred = phones.filter(row => row.isPreferred);
    expect(preferred).toHaveLength(1);
    expect((await db.select().from(customers).where(eq(customers.id, busy)))[0]!.phone).toBe(preferred[0]!.value);
  });

  it("arquivar dois contatos ao mesmo tempo nunca deixa arquivado como preferencial nem telefone de contato arquivado na ficha", async () => {
    for (let round = 0; round < 12; round += 1) {
      const [{ id: pair }] = await db.insert(customers).values({ fullName: `Par Sintético ${runId}-${round}`, status: "active" }).$returningId();
      const a = await caller().add({ customerId: pair, kind: "phone", value: `849600${String(round).padStart(2, "0")}01` });
      const b = await caller().add({ customerId: pair, kind: "phone", value: `849600${String(round).padStart(2, "0")}02` });
      const results = await Promise.allSettled([caller().archive({ contactId: a.contactId }), caller().archive({ contactId: b.contactId })]);
      expect(results.filter(result => result.status === "rejected")).toEqual([]);
      const rows = (await caller().list({ customerId: pair, includeArchived: true })).filter(row => row.kind === "phone");
      expect(rows.filter(row => row.isPreferred)).toEqual([]);
      expect((await db.select().from(customers).where(eq(customers.id, pair)))[0]!.phone).toBeNull();
    }
  });
});
