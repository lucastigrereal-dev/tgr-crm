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
  let userId: number;
  let customerId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ customerContactsRouter } = await import("./routers/customerContacts"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `contacts-${runId}`, name: "Atendente contatos", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Fulano Sintético ${runId}`, phone: "84900000000", email: `antigo-${runId}@example.test`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "seller") => customerContactsRouter.createCaller({ user: { id: userId, role } } as never);
  const customer = async () => (await db.select().from(customers).where(eq(customers.id, customerId)))[0]!;

  it("primeiro telefone vira preferencial e o principal da ficha; trocar o preferencial deixa um só", async () => {
    const first = await caller().add({ customerId, kind: "phone", value: "(84) 98888-1111", label: "trabalho" });
    expect((await customer()).phone).toBe("(84) 98888-1111");
    const second = await caller().add({ customerId, kind: "phone", value: "+55 84 97777-2222" });
    expect((await customer()).phone).toBe("(84) 98888-1111"); // segundo não muda o principal
    await caller().setPreferred({ contactId: second.contactId });
    const phones = (await caller().list({ customerId })).filter(row => row.kind === "phone");
    expect(phones.filter(row => row.isPreferred).map(row => row.id)).toEqual([second.contactId]);
    expect(phones.map(row => row.id)).toContain(first.contactId);
    expect((await customer()).phone).toBe("+55 84 97777-2222");
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

});
