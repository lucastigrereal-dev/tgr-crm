import { describe, expect, it } from "vitest";
import { buildCaptureProfileAnalytics, getProfileCompleteness, profileSearchText, type CaptureProfile } from "./captureSegmentation";

function makeProfile(overrides: Partial<CaptureProfile> = {}): CaptureProfile {
  return {
    id: 1, createdAt: new Date("2026-01-01T12:00:00Z"), customerName: "Ana da Silva", customerDocumentNumber: "12345678900", customerEmail: "ana@example.com", customerPhone: "11999999999", city: "São Paulo", state: "SP", resortId: 1, resortName: "TGR Resort", promoterId: 2, qualifierId: 3, linerId: 4, closerId: 5, roomManagerId: 6, campaignId: 7, campaignName: "Verão", salesRoom: "Sala A", captureLocation: "Lobby", lodgingLocation: "Hotel TGR", transportation: "Carro próprio", isPasserby: false, scheduledAt: new Date("2026-01-02T12:00:00Z"), presentationStatus: "closed", qualificationStatus: "qualified", partnerName: "Bruno da Silva", partnerAge: 39, partnerProfession: "Engenheiro", relationshipStatus: "Casados", relationshipYears: 8, relationshipMonths: 2, childrenCount: 2, childrenNames: "Lia; Caio", averageIncome: 18000, vehicleBrand: "Toyota", vehicleModel: "Corolla", vehicleYear: 2023, hasCreditCard: true, creditCardBrands: "Visa; Mastercard", acceptsCheque: false, ownsHome: true, ownsPropertyInCity: false, travelWeeksPerYear: 3, usualTravelSeason: "Julho", dreamTrips: "Europa", lastTrip: "Gramado", averageHotelSpend: 4200, nextFamilyTrip: "Bahia", socialNetworks: "Instagram", giftDescription: "Kit praia", qualificationReason: "Perfil aderente", notes: "Retornar em janeiro", opportunityStage: "won", checkedInAt: new Date("2026-01-02T12:10:00Z"), presentationStartedAt: new Date("2026-01-02T12:30:00Z"), ...overrides,
  };
}

describe("segmentação histórica da ficha", () => {
  it("calcula completude de todos os blocos do perfil", () => {
    const result = getProfileCompleteness(makeProfile());
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("agrupa carro, cidade, filhos e qualificação com métricas comerciais", () => {
    const result = buildCaptureProfileAnalytics([
      makeProfile(),
      makeProfile({ id: 2, customerName: "Carlos", vehicleBrand: "Toyota", city: "São Paulo", childrenCount: 0, qualificationStatus: "pending", opportunityStage: "proposal", averageIncome: 12000 }),
      makeProfile({ id: 3, customerName: "Maria", vehicleBrand: "Honda", city: "Campinas", childrenCount: 1, opportunityStage: "lost", averageIncome: null }),
    ]);
    expect(result.total).toBe(3);
    expect(result.qualified).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.averageIncome).toBe(15000);
    expect(result.averageChildren).toBe(1);
    expect(result.byVehicleBrand.find(row => row.label === "Toyota")).toMatchObject({ count: 2, qualified: 1, wins: 1 });
    expect(result.byCity.find(row => row.label === "Campinas")).toMatchObject({ count: 1, wins: 0 });
    expect(result.byChildrenCount.find(row => row.label === "0")).toMatchObject({ count: 1 });
  });

  it("permite buscar texto em campos de relacionamento e perfil", () => {
    const searchable = profileSearchText(makeProfile({ creditCardBrands: "Visa Infinite", dreamTrips: "Patagônia" }));
    expect(searchable).toContain("visa infinite");
    expect(searchable).toContain("patagônia");
  });
});
