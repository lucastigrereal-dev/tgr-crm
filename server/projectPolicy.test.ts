import { expect, it } from "vitest";
import { getProjectCaptureReadiness, parseCommissionPolicy, parseRequiredCaptureFields } from "./projectPolicy";
it("aceita apenas campos configuráveis conhecidos", () => expect(parseRequiredCaptureFields('["vehicle","xpto","homeOwnership"]')).toEqual(["vehicle", "homeOwnership"]));
it("inclui veículo e moradia quando o projeto exigir", () => { const result = getProjectCaptureReadiness({ customerName: "Ana", phone: "1", city: "Olímpia", promoterId: 1, captureLocation: "Rua", averageIncome: 1, travelWeeksPerYear: 1, qualificationStatus: "qualified" }, '["vehicle","homeOwnership"]'); expect(result.missing).toEqual(["Veículo", "Moradia"]); });
it("lê política de comissão configurável sem quebrar com JSON inválido", () => { expect(parseCommissionPolicy('{"linerRate":0.02,"expectedPaymentDay":20}')).toEqual({ linerRate: 0.02, expectedPaymentDay: 20 }); expect(parseCommissionPolicy("{ruim")).toEqual({}); });
