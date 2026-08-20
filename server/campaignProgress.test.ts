import { describe, expect, it } from "vitest";
import { calculateCampaignProgress } from "./campaignProgress";

describe("campaign progress", () => {
  it("calcula progresso, distância e superação sem esconder ultrapassagem", () => {
    expect(calculateCampaignProgress(100_000, 72_500)).toEqual({ targetAmount: 100_000, salesAmount: 72_500, percentage: 72.5, progress: 72.5, gapAmount: 27_500, exceededAmount: 0 });
    expect(calculateCampaignProgress(100_000, 120_000)).toEqual({ targetAmount: 100_000, salesAmount: 120_000, percentage: 120, progress: 100, gapAmount: 0, exceededAmount: 20_000 });
  });

  it("não inventa percentual quando a meta ainda não foi definida", () => {
    expect(calculateCampaignProgress(0, 5_000)).toMatchObject({ percentage: 0, progress: 0, gapAmount: 0, exceededAmount: 5_000 });
  });
});
