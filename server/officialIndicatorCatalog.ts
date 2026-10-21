/**
 * Item 10 (admin): lista editável e versionada dos indicadores oficiais do CRM. O que muda aqui é só nome, descrição e se aparece; a FÓRMULA (aproveitamento,
 * eficiência) continua no código (`officialIndicators.ts`) e o contrato com o Relationship não muda. Sem linha gravada, vale o padrão abaixo.
 */
export const OFFICIAL_INDICATOR_CODES = ["utilization", "efficiency"] as const;
export type OfficialIndicatorCode = (typeof OFFICIAL_INDICATOR_CODES)[number];

export type IndicatorCatalogEntry = { code: OfficialIndicatorCode; version: number; label: string; description: string; active: boolean; isDefault: boolean };
export type IndicatorVersionRow = { code: string; version: number; label: string; description: string; active: boolean };

export const DEFAULT_INDICATOR_CATALOG: Record<OfficialIndicatorCode, Omit<IndicatorCatalogEntry, "code" | "isDefault">> = {
  utilization: { version: 0, label: "Aproveitamento", description: "Vendas validadas pelo CRM dividido pelos atendimentos com desfecho, em porcentagem.", active: true },
  efficiency: { version: 0, label: "Eficiência", description: "Cotas vendidas por 100 atendimentos com desfecho.", active: true },
};

export const isIndicatorCode = (code: string): code is OfficialIndicatorCode => (OFFICIAL_INDICATOR_CODES as readonly string[]).includes(code);

/** Versão vigente por código = a maior; o que não tem linha cai no padrão. Linhas de código desconhecido são ignoradas. */
export function resolveIndicatorCatalog(rows: IndicatorVersionRow[]): IndicatorCatalogEntry[] {
  return OFFICIAL_INDICATOR_CODES.map(code => {
    const latest = rows.filter(row => row.code === code).sort((a, b) => b.version - a.version)[0];
    return latest ? { code, version: latest.version, label: latest.label, description: latest.description, active: latest.active, isDefault: false } : { code, ...DEFAULT_INDICATOR_CATALOG[code], isDefault: true };
  });
}
