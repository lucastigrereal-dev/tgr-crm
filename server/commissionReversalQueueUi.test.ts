import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sem infraestrutura de teste de componente no repositório: contrato de código da UI (ADR-010, fila de estorno).
const queue = readFileSync(join(__dirname, "..", "client/src/components/crm/CommissionReversalQueue.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "client/src/pages/Commissions.tsx"), "utf8");

describe("CommissionReversalQueue", () => {
  it("só consulta e só aparece para quem tem commission.pay", () => {
    expect(queue).toMatch(/canCapability\(user\.role, "commission\.pay"\)/);
    expect(queue).toMatch(/reversalQueue\.useQuery\(undefined, \{ enabled: canResolve \}\)/);
    expect(queue).toMatch(/if \(!canResolve\) return null/);
  });
  it("oferece as três decisões e exige nota ao resolver", () => {
    for (const value of ["reversed", "offset", "waived"]) expect(queue).toContain(`value: "${value}"`);
    expect(queue).toMatch(/resolveReversalReview\.useMutation/);
    expect(queue).toMatch(/resolve\.mutate\(\{ id: selectedId, decision, note: note\.trim\(\)/);
    expect(queue).toMatch(/required/);
  });
  it("está montada na página de comissões", () => {
    expect(page).toMatch(/<CommissionReversalQueue \/>/);
  });
});
