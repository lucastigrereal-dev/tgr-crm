import { expect, it } from "vitest";
import { getProjectCaptureReadiness, parseRequiredCaptureFields } from "./projectPolicy";
it("aceita apenas campos configuráveis conhecidos", () => expect(parseRequiredCaptureFields('["vehicle","xpto","homeOwnership"]')).toEqual(["vehicle", "homeOwnership"]));
it("inclui veículo e moradia quando o projeto exigir", () => { const result = getProjectCaptureReadiness({ customerName: "Ana", phone: "1", city: "Olímpia", promoterId: 1, captureLocation: "Rua", averageIncome: 1, travelWeeksPerYear: 1, qualificationStatus: "qualified" }, '["vehicle","homeOwnership"]'); expect(result.missing).toEqual(["Veículo", "Moradia"]); });
