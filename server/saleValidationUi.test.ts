import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sem infraestrutura de teste de componente no repositório: contrato de código da UI (revisão KAN-31, item 12).
const card = readFileSync(join(__dirname, "..", "client/src/components/crm/SaleValidationCard.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "client/src/pages/ContractDetail.tsx"), "utf8");

describe("SaleValidationCard", () => {
  it("desabilita Confirmar pagamento e Validar venda para contrato cancelado/encerrado/vencido", () => {
    expect(card).toMatch(/\["cancelled", "closed", "overdue"\]\.includes\(data\.contractStatus\)/);
    expect(card).toMatch(/Confirmar pagamento<\/Button>/);
    expect(card).toMatch(/disabled=\{terminalStatus\}>Confirmar pagamento/);
    expect(card).toMatch(/disabled=\{terminalStatus \|\| !data\.gates\.ready \|\| validate\.isPending\}/);
  });
  it("só consulta e só aparece para quem tem sale.validation.view (admin/finance)", () => {
    expect(card).toMatch(/enabled: Boolean\(contractId\) && canView/);
    expect(page).toMatch(/canCapability\(user\.role, "sale\.validation\.view"\) \? <SaleValidationCard/);
  });
  it("mostra o portão de distrato aberto", () => {
    expect(card).toMatch(/noOpenCancellation/);
  });
});

describe("Anexo de contrato assinado", () => {
  it("envia signed=true só na categoria Contrato assinado e só para quem tem document.sign", () => {
    expect(page).toMatch(/const canUploadSigned = Boolean\(user && canCapability\(user\.role, "document\.sign"\)\)/);
    expect(page).toMatch(/const signed = category === "Contrato assinado" && canUploadSigned;/);
    expect(page).toMatch(/base64, signed \}\)/);
    expect(page).not.toMatch(/signed: false \}\)/);
  });
});
