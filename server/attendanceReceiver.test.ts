import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ATTENDANCE_CONTRACT_SECTION } from "../shared/contracts/attendanceSection";
import { attendanceEventId, attendanceHash, attendanceSchema, ATTENDANCE_OUTCOMES, ATTENDANCE_PATH, ATTENDANCE_TOPIC } from "./attendanceReceiver";

// C1: o receptor valida EXATAMENTE o que o contrato da Suite (seção `attendance`) diz: todos os valid passam, todos os invalid são recusados.
const section = ATTENDANCE_CONTRACT_SECTION as unknown as { eventName: string; path: string; outcome: { values: string[] }; valid: Record<string, unknown>[]; invalid: { why: string; body: unknown }[] };

describe("encounter.attendance_recorded.v1: contrato do receptor", () => {
  it("nome, rota e desfechos batem com a seção publicada", () => {
    expect(section.eventName).toBe(ATTENDANCE_TOPIC);
    expect(section.path).toBe(ATTENDANCE_PATH);
    expect(section.outcome.values).toEqual([...ATTENDANCE_OUTCOMES]);
  });
  it("todos os valid passam e todos os invalid são recusados", () => {
    expect(section.valid.length).toBeGreaterThanOrEqual(5);
    for (const body of section.valid) expect(attendanceSchema.safeParse(body).error?.issues ?? [], JSON.stringify(body)).toEqual([]);
    for (const item of section.invalid) expect(attendanceSchema.safeParse(item.body).success, item.why).toBe(false);
  });
  it("eventId é o derivado de (atendimento, revisão): outro valor é recusado", () => {
    const base = section.valid[0] as { encounterId: string; revision: number };
    expect(base && section.valid.every(v => (v.eventId as string) === attendanceEventId(v.encounterId as string, v.revision as number))).toBe(true);
    expect(attendanceSchema.safeParse({ ...base, eventId: attendanceEventId(base.encounterId, base.revision + 1) }).success).toBe(false);
  });
  it("telefone é texto livre (não exige E.164) e o hash muda com qualquer campo do corpo", () => {
    const base = section.valid[1] as Record<string, unknown>;
    const parsed = (patch: Record<string, unknown>) => attendanceSchema.parse({ ...base, ...patch });
    expect(attendanceSchema.safeParse({ ...base, couple: { phone: "+55 (84) 99999-0002 ramal 3" } }).success).toBe(true);
    const h = attendanceHash(parsed({}));
    expect(attendanceHash(parsed({ correlationId: "outro" }))).not.toBe(h);
    expect(attendanceHash(parsed({ couple: { primaryName: "Outro" } }))).not.toBe(h);
    expect(attendanceHash(parsed({}))).toBe(h);
  });
  it("a flag nasce desligada e a rota responde 404 com a chave certa quando desligada (arquivo de exemplo e compose)", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).toMatch(/^ATTENDANCE_RECEIVER_ENABLED=false/m);
    expect(readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8")).toContain("ATTENDANCE_RECEIVER_ENABLED: \"${ATTENDANCE_RECEIVER_ENABLED:-false}\"");
    expect(readFileSync(path.join(root, "server/_core/env.ts"), "utf8")).toContain('attendanceReceiverEnabled: process.env.ATTENDANCE_RECEIVER_ENABLED === "true"');
  });
});
