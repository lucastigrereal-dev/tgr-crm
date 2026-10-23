import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// O compose do piloto é a allowlist de ambiente do app: flag que não está lá nunca chega ao processo. Toda flag nova nasce DESLIGADA.
const root = path.resolve(import.meta.dirname, "..");
const compose = readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8");
const example = readFileSync(path.join(root, ".env.example"), "utf8");

describe("flags da rodada 4 no compose do piloto", () => {
  it.each([
    "FINANCIAL_PROJECT_MAP_ENABLED", "OFFICIAL_INDICATOR_CATALOG_ENABLED", "COMMISSION_ROLE_MAP_ENABLED", "FEATURE_FLAG_OVERRIDES_ENABLED", "PERMISSION_OVERRIDES_ENABLED", "CONTRACT_ADDENDUM_ENABLED", "CSRF_ORIGIN_CHECK_ENABLED", "SALE_ORDER_GATE_ENABLED", "INVENTORY_HOLD_AT_FORMALIZATION", "INSTALLMENT_EVIDENCE_IN_EVENT", "COMMISSION_POLICY_VERSIONING_ENABLED", "COMMISSION_CANCEL_POLICY_ENABLED", "QUALIFICATION_POLICY_VERSIONING_ENABLED", "SALE_VALIDATED_QUOTAS_COUNT_ENABLED", "PRIVACY_ERASURE_PROPAGATION_ENABLED",
  ])("%s está no environment do serviço app com padrão false e documentada no .env.example como false", name => {
    expect(compose).toContain(`${name}: "\${${name}:-false}"`);
    expect(example).toMatch(new RegExp(`^${name}=false`, "m"));
  });
  it("CSRF_ALLOWED_ORIGINS passa ao app com padrão vazio", () => {
    expect(compose).toContain('CSRF_ALLOWED_ORIGINS: "${CSRF_ALLOWED_ORIGINS:-}"');
    expect(example).toMatch(/^CSRF_ALLOWED_ORIGINS=/m);
  });
  it("SALE_ORDER_GATE_SINCE passa ao app com padrão vazio", () => {
    expect(compose).toContain('SALE_ORDER_GATE_SINCE: "${SALE_ORDER_GATE_SINCE:-}"');
  });
  it("as flags ficam dentro do serviço app (antes do PORT dele)", () => {
    const app = compose.slice(compose.indexOf("\n  app:"));
    for (const name of ["FINANCIAL_PROJECT_MAP_ENABLED", "CONTRACT_ADDENDUM_ENABLED", "CSRF_ORIGIN_CHECK_ENABLED", "CSRF_ALLOWED_ORIGINS"]) expect(app).toContain(name);
  });
});
