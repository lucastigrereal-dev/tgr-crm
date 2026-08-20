import { expect, it } from "vitest";
import { simulateCancellation } from "./cancellationDomain";

it("simula multa sobre pago com devolução após multa", () => { expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { penaltyRate: 0.1, penaltyBase: "paid", refundMode: "after_penalty" } })).toMatchObject({ penalty: 200, refund: 1800, retained: 200 }); });
it("respeita retenção total configurada pelo empreendimento", () => { expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { refundMode: "none" } }).refund).toBe(0); });
