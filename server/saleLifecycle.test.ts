import { expect, it } from "vitest";
import { saleStageFromFacts } from "./saleLifecycle";

it("mantém proposta aceita separada de venda validada", () => {
  expect(saleStageFromFacts({ proposalAccepted: true })).toBe("proposal_accepted");
  expect(
    saleStageFromFacts({
      proposalAccepted: true,
      contractCreatedAt: new Date("2026-08-20T12:00:00Z"),
    }),
  ).toBe("contract_pending_signature");
  expect(
    saleStageFromFacts({
      proposalAccepted: true,
      contractSignedAt: new Date("2026-08-20T12:00:00Z"),
    }),
  ).toBe("sale_validation_pending");
});

it("não trata oportunidade ganha como prova de validação ou recebimento", () => {
  expect(saleStageFromFacts({})).toBe("proposal_draft");
  expect(
    saleStageFromFacts({
      proposalAccepted: true,
      contractSignedAt: new Date("2026-08-20T12:00:00Z"),
    }),
  ).not.toBe("payment_confirmed");
});

it("só sobe para validada e caixa quando os fatos existem", () => {
  expect(
    saleStageFromFacts({ saleValidatedAt: new Date("2026-08-21T12:00:00Z") }),
  ).toBe("sale_validated");
  expect(
    saleStageFromFacts({ paymentConfirmedAt: new Date("2026-08-22T12:00:00Z") }),
  ).toBe("payment_confirmed");
});
