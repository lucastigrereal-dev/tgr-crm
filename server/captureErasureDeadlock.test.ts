import { describe, expect, it } from "vitest";
import { completeErasure } from "./captureErasure";

// O scrub de domain_events disputa lock com inserts de outras transações: o InnoDB pode derrubar o cumprimento por deadlock (1213). Ele repete do zero.
const deadlock = () => Object.assign(new Error("Deadlock found when trying to get lock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });

describe("completeErasure sob deadlock", () => {
  it("repete a transação inteira quando o MySQL derruba por deadlock e devolve o resultado da tentativa que fecha", async () => {
    let attempts = 0;
    const db = { transaction: async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("Failed query"), { cause: deadlock() }); return { requestId: 7, sheetsAnonymized: 1, giftDate: new Date(0) }; } };
    await expect(completeErasure(db as never, { requestId: 7, confirmCode: "X", actorUserId: 1 })).resolves.toMatchObject({ requestId: 7 });
    expect(attempts).toBe(3);
  });
  it("erro que não é deadlock sobe na hora, sem repetir", async () => {
    let attempts = 0;
    const db = { transaction: async () => { attempts += 1; throw new Error("outro erro"); } };
    await expect(completeErasure(db as never, { requestId: 7, confirmCode: "X", actorUserId: 1 })).rejects.toThrow("outro erro");
    expect(attempts).toBe(1);
  });
});
