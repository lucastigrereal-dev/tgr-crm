import { describe, expect, it } from "vitest";
import { NO_CONSULTANT_LABEL, NO_ORIGIN_LABEL, buildAverageTimeByConsultant, buildSalesByOrigin, presentationMinutes, type ReportSource } from "../shared/captureSheetReports";
import { buildCaptureExportRows } from "../shared/captureSheetExport";

const at = (hhmm: string) => new Date(`2026-10-17T${hhmm}:00Z`);
const row = (extra: Partial<ReportSource> = {}): ReportSource => ({ captureLocation: "Shopping A", presentationStatus: "presented", commercialOutcome: null, ntKind: null, linerName: "Ana", presentationStartedAt: at("12:00"), presentationEndedAt: at("12:40"), ...extra });

describe("relatórios da sala: funções puras", () => {
  it("minutos da apresentação: nulo sem início/fim ou com fim antes do início", () => {
    expect(presentationMinutes(at("12:00"), at("12:45"))).toBe(45);
    expect(presentationMinutes(null, at("12:45"))).toBeNull();
    expect(presentationMinutes(at("13:00"), at("12:00"))).toBeNull();
  });

  it("vendas por origem conta vendeu, caiu em mesa e NT; sem tour a conversão é nula", () => {
    const result = buildSalesByOrigin([
      row({ commercialOutcome: "vendeu", presentationStatus: "closed" }),
      row({ commercialOutcome: "caiu_em_mesa" }),
      row(),
      row({ presentationStatus: "no_tour", ntKind: "perfil", commercialOutcome: null }),
      row({ captureLocation: null, presentationStatus: "no_tour", ntKind: "tempo" }),
    ]);
    const a = result.find(item => item.origin === "Shopping A")!;
    expect(a).toMatchObject({ fichas: 4, tours: 3, vendeu: 1, caiuEmMesa: 1, naoTour: 1, conversaoPct: 33.3 });
    const none = result.find(item => item.origin === NO_ORIGIN_LABEL)!;
    expect(none).toMatchObject({ fichas: 1, tours: 0, naoTour: 1, conversaoPct: null });
    expect(result[0]!.origin).toBe("Shopping A");
  });

  it("tempo médio por consultor ignora quem não apresentou e quem não tem horário", () => {
    const result = buildAverageTimeByConsultant([
      row(), row({ presentationEndedAt: at("13:00") }),
      row({ presentationEndedAt: null }),
      row({ linerName: null }),
      row({ presentationStatus: "no_tour", ntKind: "perfil" }),
    ]);
    const ana = result.find(item => item.consultant === "Ana")!;
    expect(ana).toMatchObject({ apresentacoes: 3, comTempo: 2, mediaMin: 50, minimoMin: 40, maximoMin: 60 });
    expect(result.find(item => item.consultant === NO_CONSULTANT_LABEL)).toMatchObject({ apresentacoes: 1, comTempo: 1, mediaMin: 40 });
    expect(result.some(item => item.consultant === "Ana" && item.apresentacoes > 3)).toBe(false);
  });

  it("dois consultores com o mesmo nome ficam em linhas separadas", () => {
    const result = buildAverageTimeByConsultant([row({ linerId: 1, linerName: "Ana Silva" }), row({ linerId: 2, linerName: "Ana Silva" }), row({ linerId: 2, linerName: "Ana Silva" })]);
    expect(result.map(item => item.apresentacoes).sort()).toEqual([1, 2]);
  });

  it("captura importada (closed sem início de apresentação) não vira tour nem apresentação", () => {
    const imported = row({ presentationStatus: "closed", presentationStartedAt: null, presentationEndedAt: null, linerName: null });
    expect(buildSalesByOrigin([imported])[0]).toMatchObject({ fichas: 1, tours: 0, conversaoPct: null });
    expect(buildAverageTimeByConsultant([imported])).toEqual([]);
  });

  it("a exportação traz tipo e motivo do NT e o tempo da apresentação", () => {
    const [exported] = buildCaptureExportRows([{ customerName: "Casal Teste", ntKind: "perfil", noTourReason: "Idade fora do perfil: x", presentationStartedAt: at("12:00"), presentationEndedAt: at("12:30") } as never], { withCpf: false, timeZone: "UTC" });
    expect(exported).toMatchObject({ Tipo_NT: expect.any(String), Motivo_sem_tour: "Idade fora do perfil: x", Minutos_apresentacao: 30 });
  });
});
