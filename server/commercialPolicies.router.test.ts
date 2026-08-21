import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);
import { appRouter } from "./routers";

function context(): TrpcContext {
  return { user: { id: 9, openId: "admin", email: "admin@tgr.local", name: "Admin", loginMethod: "test", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: { clearCookie: () => undefined } as TrpcContext["res"] };
}
function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  promise.from = () => promise; promise.where = () => promise; promise.orderBy = () => promise;
  return promise;
}

describe("commercial policies router", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista política vigente e cria versão com auditoria", async () => {
    const select = vi.fn(() => chain([{ id: 4, resortId: 2, policyType: "commission", version: "2026.08", policyJson: "{}", effectiveAt: new Date(), retiredAt: null }]));
    const returning = vi.fn().mockResolvedValue([{ id: 12 }]);
    const values = vi.fn(() => ({ $returningId: returning }));
    dbMocks.getDb.mockResolvedValue({ select, insert: vi.fn(() => ({ values })) });
    const caller = appRouter.createCaller(context());
    const rows = await caller.commercialPolicies.list({ resortId: 2, policyType: "commission" });
    const created = await caller.commercialPolicies.create({ resortId: 2, policyType: "revenue_quality", version: "v1", policy: { maturityDays: 90 } });
    expect(rows).toHaveLength(1);
    expect(created).toEqual({ id: 12 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ approvedByUserId: 9, version: "v1" }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "commercial_policy_version", 12, "created", expect.stringContaining("revenue_quality"));
  });

  it("aposenta versão sem apagá-la", async () => {
    const where = vi.fn().mockResolvedValue({ affectedRows: 1 });
    const set = vi.fn(() => ({ where }));
    dbMocks.getDb.mockResolvedValue({ update: vi.fn(() => ({ set })) });
    const result = await appRouter.createCaller(context()).commercialPolicies.retire({ id: 12 });
    expect(result).toEqual({ success: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ retiredAt: expect.any(Date) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "commercial_policy_version", 12, "retired", expect.any(String));
  });
});
