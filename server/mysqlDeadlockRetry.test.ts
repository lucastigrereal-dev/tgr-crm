import { describe, expect, it, vi } from "vitest";
import { isDeadlockError, withDeadlockRetry } from "./mysqlErrors";

// Deadlock do InnoDB derruba a transação inteira; repetir é seguro e é o que o MySQL manda fazer.
const deadlock = () => Object.assign(new Error("Failed query: select ... for update"), { cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } });

describe("withDeadlockRetry", () => {
  it("reconhece o deadlock embrulhado pelo drizzle e ignora outros erros", () => {
    expect(isDeadlockError(deadlock())).toBe(true);
    expect(isDeadlockError({ cause: { cause: { errno: 1213 } } })).toBe(true);
    expect(isDeadlockError(Object.assign(new Error("dup"), { cause: { code: "ER_DUP_ENTRY", errno: 1062 } }))).toBe(false);
  });

  it("repete a transação depois de deadlock e devolve o resultado", async () => {
    const run = vi.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockResolvedValueOnce("ok");
    await expect(withDeadlockRetry(run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("desiste depois da última tentativa e não repete erro que não é deadlock", async () => {
    const always = vi.fn().mockRejectedValue(deadlock());
    await expect(withDeadlockRetry(always, 3)).rejects.toMatchObject({ cause: { errno: 1213 } });
    expect(always).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockRejectedValue(new Error("regra de negócio"));
    await expect(withDeadlockRetry(other)).rejects.toThrow("regra de negócio");
    expect(other).toHaveBeenCalledTimes(1);
  });
});
