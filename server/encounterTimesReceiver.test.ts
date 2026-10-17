import { describe, expect, it } from "vitest";
import { encounterTimesHash, encounterTimesSchema } from "./encounterTimesReceiver";

const base = () => ({
  eventId: "evt-1", eventName: "encounter.times_recorded.v1" as const, source: "sales-command" as const, correlationId: "corr-1", occurredAt: "2026-10-17T15:00:00Z", coupleCode: "TGR-0001",
  times: { waitStartedAt: "2026-10-17T14:00:00Z", waitEndedAt: "2026-10-17T14:10:00Z", consultantStartedAt: "2026-10-17T14:10:00Z", consultantEndedAt: "2026-10-17T14:50:00Z" },
});

describe("encounter.times_recorded.v1: contrato", () => {
  it("aceita o evento completo e parcial", () => {
    expect(encounterTimesSchema.safeParse(base()).success).toBe(true);
    expect(encounterTimesSchema.safeParse({ ...base(), times: { consultantDispensed: true, closerStartedAt: "2026-10-17T14:00:00Z" } }).success).toBe(true);
  });

  it("recusa campo extra, nome de evento errado, sem horário e fim antes do início", () => {
    expect(encounterTimesSchema.safeParse({ ...base(), cpf: "123" }).success).toBe(false);
    expect(encounterTimesSchema.safeParse({ ...base(), eventName: "encounter.times_recorded.v2" }).success).toBe(false);
    expect(encounterTimesSchema.safeParse({ ...base(), times: {} }).success).toBe(false);
    expect(encounterTimesSchema.safeParse({ ...base(), times: { waitStartedAt: "2026-10-17T14:10:00Z", waitEndedAt: "2026-10-17T14:00:00Z" } }).success).toBe(false);
    expect(encounterTimesSchema.safeParse({ ...base(), times: { waitStartedAt: "ontem" } }).success).toBe(false);
  });

  it("o hash muda quando o conteúdo muda e ignora o eventId", () => {
    const a = encounterTimesSchema.parse(base());
    expect(encounterTimesHash(a)).toBe(encounterTimesHash({ ...a, eventId: "outro" }));
    expect(encounterTimesHash(a)).not.toBe(encounterTimesHash({ ...a, times: { ...a.times, endedAt: "2026-10-17T15:00:00Z" } }));
  });
});
