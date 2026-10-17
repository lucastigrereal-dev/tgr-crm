/**
 * Primeiros relatórios da sala (decisão 17/10 do Lucas): vendas por origem e tempo médio por consultor.
 * Conta só o que a sala marcou (VENDEU / CAIU EM MESA): isto NÃO é venda validada, que só existe no CRM com
 * pagamento, contrato e assinatura. Função pura para o teste cobrir sem banco nem navegador.
 */
export type ReportSource = {
  captureLocation: string | null;
  presentationStatus: string;
  commercialOutcome: "vendeu" | "caiu_em_mesa" | null;
  ntKind: string | null;
  linerId?: number | null;
  linerName: string | null;
  presentationStartedAt: Date | string | null;
  presentationEndedAt: Date | string | null;
};

/** Tour de verdade: status de apresentação E início registrado (capturas importadas já nascem "closed" sem apresentação). */
function isRealTour(row: ReportSource) {
  return (row.presentationStatus === "presented" || row.presentationStatus === "closed") && !!row.presentationStartedAt;
}

export const NO_ORIGIN_LABEL = "(sem origem)";
export const NO_CONSULTANT_LABEL = "(sem consultor)";

/** Minutos inteiros (piso, igual a tourDurationMinutes) da apresentação; sem início/fim, ou fim antes do início, não entra na média. */
export function presentationMinutes(start: Date | string | null, end: Date | string | null) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 60_000) : null;
}

export type OriginRow = { origin: string; fichas: number; tours: number; vendeu: number; caiuEmMesa: number; naoTour: number; conversaoPct: number | null };
export type ConsultantRow = { consultantKey: string; consultant: string; apresentacoes: number; comTempo: number; mediaMin: number | null; minimoMin: number | null; maximoMin: number | null };

const originKey = (value: string | null) => value?.trim() || NO_ORIGIN_LABEL;

export function buildSalesByOrigin(rows: ReportSource[]): OriginRow[] {
  const map = new Map<string, OriginRow>();
  for (const row of rows) {
    const key = originKey(row.captureLocation);
    const item = map.get(key) ?? { origin: key, fichas: 0, tours: 0, vendeu: 0, caiuEmMesa: 0, naoTour: 0, conversaoPct: null };
    item.fichas += 1;
    if (isRealTour(row)) item.tours += 1;
    if (row.presentationStatus === "no_tour" || row.ntKind) item.naoTour += 1;
    if (row.commercialOutcome === "vendeu") item.vendeu += 1;
    if (row.commercialOutcome === "caiu_em_mesa") item.caiuEmMesa += 1;
    map.set(key, item);
  }
  // Conversão da sala: VENDEU sobre as apresentações; sem apresentação não há conta (em vez de 0%).
  for (const item of Array.from(map.values())) item.conversaoPct = item.tours > 0 ? Math.round((item.vendeu / item.tours) * 1000) / 10 : null;
  return Array.from(map.values()).sort((a, b) => b.vendeu - a.vendeu || b.tours - a.tours || a.origin.localeCompare(b.origin, "pt-BR"));
}

export function buildAverageTimeByConsultant(rows: ReportSource[]): ConsultantRow[] {
  const map = new Map<string, { item: ConsultantRow; minutes: number[] }>();
  for (const row of rows) {
    if (!isRealTour(row)) continue;
    const label = row.linerName?.trim() || NO_CONSULTANT_LABEL;
    // Nomes de usuário não são únicos: agrupa pelo id do consultor e usa o nome só como rótulo.
    const key = row.linerId != null ? `id:${row.linerId}` : `nome:${label}`;
    const entry = map.get(key) ?? { item: { consultantKey: key, consultant: label, apresentacoes: 0, comTempo: 0, mediaMin: null, minimoMin: null, maximoMin: null }, minutes: [] };
    entry.item.apresentacoes += 1;
    const minutes = presentationMinutes(row.presentationStartedAt, row.presentationEndedAt);
    if (minutes !== null) entry.minutes.push(minutes);
    map.set(key, entry);
  }
  return Array.from(map.values()).map(({ item, minutes }) => {
    if (minutes.length) {
      item.comTempo = minutes.length;
      item.mediaMin = Math.round((minutes.reduce((sum: number, value: number) => sum + value, 0) / minutes.length) * 10) / 10;
      item.minimoMin = Math.min(...minutes);
      item.maximoMin = Math.max(...minutes);
    }
    return item;
  }).sort((a, b) => b.apresentacoes - a.apresentacoes || a.consultant.localeCompare(b.consultant, "pt-BR"));
}
