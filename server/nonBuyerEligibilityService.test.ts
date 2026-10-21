import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { primaryReason, reevaluateIfEnabled } from "./nonBuyerEligibilityService";

describe("C2/C3 fatia 3: serviço de reavaliação (sem banco)", () => {
  it("flag desligada: não faz NADA, nem toca na transação", async () => {
    const tx = new Proxy({}, { get() { throw new Error("tx não pode ser usada com a flag desligada"); } });
    expect(await reevaluateIfEnabled(tx as never, { captureId: 1 }, false)).toEqual([]);
    expect(await reevaluateIfEnabled(tx as never, { customerId: 1 }, false)).toEqual([]);
  });
  it("motivo único do evento de revogação tem prioridade fixa", () => {
    expect(primaryReason(["sale_in_progress", "opt_out", "anonymized"])).toBe("anonymized");
    expect(primaryReason(["sale_in_progress", "opt_out"])).toBe("opt_out");
    expect(primaryReason(["attendance_not_finished", "sale_in_progress"])).toBe("sale_in_progress");
    expect(primaryReason(["attendance_not_finished"])).toBe("attendance_not_finished");
  });
  it("ordem de locks documentada e respeitada: um único FOR UPDATE (linha de estado), nenhum lock em linha de negócio, ficha em ordem crescente", () => {
    const raw = readFileSync(path.resolve(__dirname, "nonBuyerEligibilityService.ts"), "utf8");
    expect(raw).toContain("ORDEM DE LOCKS");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/\.for\(/g)).toHaveLength(1);
    expect(code).toContain('.for("update")');
    expect(code).not.toMatch(/\.for\("share"\)|lockInShareMode|forShare/);
    expect(code).toMatch(/orderBy\(asc\(captureRecords\.id\)\)/);
    // só a projeção é escrita; o evento sai por txEvent
    expect(code.match(/\.(insert|update|delete)\(\s*([A-Za-z_]\w*)\s*\)/g)!.every(m => m.includes("nonBuyerEligibilityState"))).toBe(true);
    const loader = readFileSync(path.resolve(__dirname, "nonBuyerEligibility.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(loader).not.toMatch(/\.for\(/);
  });
  it("o job só sobe com a flag ligada, no index", () => {
    const index = readFileSync(path.resolve(__dirname, "_core/index.ts"), "utf8");
    const at = index.indexOf("startNonBuyerReconciliationJob({");
    expect(at).toBeGreaterThan(0);
    expect(index.slice(index.lastIndexOf("if (", at), at)).toContain("ENV.recoveryEligibilityEnabled");
  });
});
