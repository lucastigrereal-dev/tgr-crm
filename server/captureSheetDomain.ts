import { paperDestroyPromise } from "../shared/paperPromise";
/**
 * Código do casal: o código legível (publicCode) do Sales Command, que fica na tela da sala; o QR de bip é outro (token secreto só na Suite). A ficha abre por ele, só para quem tem login e permissão
 * (o código não é segredo: o acesso é controlado pelo login). Aceita só letras, números, "-" e "_"; nunca CPF ou telefone.
 */
export const normalizeCoupleCode = (value: string) => value.trim();
/** Código só de números (mesmo com - ou _) com 8 a 13 dígitos parece telefone ou CPF e é recusado. */
export function isCoupleCode(value: string) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(value)) return false;
  const onlyNumeric = /^[\d_-]+$/.test(value);
  const digits = value.replace(/\D/g, "").length;
  return !(onlyNumeric && digits >= 8 && digits <= 13);
}

/** Tempo de relacionamento em dias, derivado de anos e meses da ficha (aproximação de 365 e 30 dias; vazio quando não informado). */
export function relationshipDays(years?: number | null, months?: number | null) {
  if (years == null && months == null) return null;
  return (years ?? 0) * 365 + (months ?? 0) * 30;
}

/**
 * Ordem de chegada: posição da ficha entre os check-ins do mesmo dia e da mesma sala, pela hora do check-in
 * (empate desempata pelo id). Sem check-in, não há ordem.
 */
export function arrivalOrder(target: { id: number; checkedInAt: Date | null }, sameDayCheckIns: Array<{ id: number; checkedInAt: Date | null }>) {
  if (!target.checkedInAt) return null;
  const before = sameDayCheckIns.filter(row => row.checkedInAt && row.id !== target.id && (row.checkedInAt.getTime() < target.checkedInAt!.getTime() || (row.checkedInAt.getTime() === target.checkedInAt!.getTime() && row.id < target.id)));
  return before.length + 1;
}

/** Limites provisórios do casal qualificado (decisão do Lucas, 17/10; lidos de capture_sheet_settings, editáveis pela administração). */
export type NqSettings = { minManAge: number; minRelationshipMonths: number; minVehicleYear: number; minIncome: number; maxItemsAccepted: number };
export const DEFAULT_NQ_SETTINGS: NqSettings = { minManAge: 30, minRelationshipMonths: 12, minVehicleYear: 2018, minIncome: 8000, maxItemsAccepted: 1 };
export const DEFAULT_MIN_PRESENTATION_MINUTES = 30;

export type NqInput = {
  maleSpouse?: "titular" | "conjuge" | null;
  /** Idade do titular, calculada da data de nascimento do cadastro (vazia quando não informada). */
  primaryAge?: number | null;
  partnerAge?: number | null;
  relationshipStatus?: string | null;
  relationshipYears?: number | null;
  relationshipMonths?: number | null;
  vehicleKind?: "carro" | "moto" | "nenhum" | null;
  vehicleYear?: number | null;
  secondVehicleKind?: "carro" | "moto" | "nenhum" | null;
  secondVehicleYear?: number | null;
  averageIncome?: number | string | null;
  hasCreditCard?: boolean | null;
  ownsHome?: boolean | null;
};
export type NqCriterion = { key: "idade_homem" | "relacionamento" | "tempo_relacionamento" | "veiculo" | "renda" | "cartao" | "casa_propria"; label: string; status: "ok" | "nq" | "missing"; detail: string };
export type NqResult = { criteria: NqCriterion[]; nqItems: number; missing: number; outcome: "qualificado" | "nq_aceito" | "nt_perfil"; label: string };

/** Idade em anos completos na data de referência; datas ilegíveis ou no futuro dão vazio. */
export function ageInYears(birthDate: Date | string | null | undefined, today: Date) {
  if (!birthDate) return null;
  const birth = birthDate instanceof Date ? birthDate : new Date(`${String(birthDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  if (today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age >= 0 ? age : null;
}

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Casal qualificado: calcula os itens de NQ e mostra ao gerente; NÃO decide sozinho (o gerente confirma).
 * Dado que falta não conta como NQ: aparece como "faltando" para o gerente completar.
 * Só carro vale (moto é sempre NQ); entre os dois veículos vale o melhor. "Da cidade" não é critério.
 */
export function computeNq(input: NqInput, settings: NqSettings = DEFAULT_NQ_SETTINGS): NqResult {
  const criteria: NqCriterion[] = [];
  const add = (key: NqCriterion["key"], label: string, status: NqCriterion["status"], detail: string) => criteria.push({ key, label, status, detail });

  const manAge = input.maleSpouse === "titular" ? input.primaryAge : input.maleSpouse === "conjuge" ? input.partnerAge : undefined;
  if (!input.maleSpouse) add("idade_homem", `Idade do homem acima de ${settings.minManAge}`, "missing", "Marque qual cônjuge é o homem.");
  else if (manAge == null) add("idade_homem", `Idade do homem acima de ${settings.minManAge}`, "missing", "Idade do homem não informada.");
  else add("idade_homem", `Idade do homem acima de ${settings.minManAge}`, manAge > settings.minManAge ? "ok" : "nq", `${manAge} anos`);

  const status = input.relationshipStatus ? fold(input.relationshipStatus) : "";
  if (!status) add("relacionamento", "Casado ou união estável", "missing", "Relacionamento não informado.");
  else if (/\b(nao|sem)\b.*(casad|uniao|estavel)|namor|solteir|noiv|ficante/.test(status)) add("relacionamento", "Casado ou união estável", "nq", input.relationshipStatus!);
  else if (/separad|divorci|viuv|\bex\b/.test(status)) add("relacionamento", "Casado ou união estável", "missing", `Relacionamento "${input.relationshipStatus}": o gerente confirma se vale.`);
  else if (/casad|uniao|estavel|marit|convive|amasi/.test(status)) add("relacionamento", "Casado ou união estável", "ok", input.relationshipStatus!);
  else add("relacionamento", "Casado ou união estável", "missing", `Relacionamento "${input.relationshipStatus}" não reconhecido: o gerente confirma.`);

  // O cadastro só tem o campo em anos: "1 ano" pode ser 12 a 23 meses. Só vira NQ ou OK quando todo o intervalo cai do mesmo lado do limite.
  const relLabel = `Relacionamento acima de ${settings.minRelationshipMonths} meses`;
  if (input.relationshipYears == null && input.relationshipMonths == null) add("tempo_relacionamento", relLabel, "missing", "Tempo de relacionamento não informado.");
  else {
    const low = (input.relationshipYears ?? 0) * 12 + (input.relationshipMonths ?? 0);
    const high = input.relationshipMonths == null ? low + 11 : low;
    if (low > settings.minRelationshipMonths) add("tempo_relacionamento", relLabel, "ok", `${input.relationshipMonths == null ? `${input.relationshipYears} ano(s) ou mais` : `${low} meses`}`);
    else if (high <= settings.minRelationshipMonths) add("tempo_relacionamento", relLabel, "nq", `${input.relationshipMonths == null ? `${input.relationshipYears} ano(s)` : `${low} meses`}`);
    else add("tempo_relacionamento", relLabel, "missing", `${input.relationshipYears} ano(s) sem os meses: informe os meses para decidir.`);
  }

  const vehicles = [{ kind: input.vehicleKind, year: input.vehicleYear }, { kind: input.secondVehicleKind, year: input.secondVehicleYear }];
  const label = `Carro de ${settings.minVehicleYear} ou mais novo`;
  if (vehicles.some(v => v.kind === "carro" && v.year != null && v.year >= settings.minVehicleYear)) add("veiculo", label, "ok", "Carro dentro do ano mínimo.");
  // Dado parcial (ex.: ano gravado sem o tipo, comum em ficha antiga) pode ainda ser um carro bom: fica "faltando", nunca vira NQ por palpite.
  else if (vehicles.every(v => v.kind == null && v.year == null)) add("veiculo", label, "missing", "Tipo do veículo não informado (carro ou moto).");
  else if (vehicles.some(v => v.kind == null && v.year != null)) add("veiculo", label, "missing", "Veículo com ano mas sem o tipo (carro ou moto).");
  else if (vehicles.some(v => v.kind === "carro" && v.year == null)) add("veiculo", label, "missing", "Ano do carro não informado.");
  else add("veiculo", label, "nq", vehicles.every(v => v.kind !== "carro") ? (vehicles.some(v => v.kind === "moto") ? "Só moto (moto não vale)." : "Sem veículo.") : "Carro mais velho que o ano mínimo.");

  const income = input.averageIncome == null || input.averageIncome === "" ? null : Number(input.averageIncome);
  if (income == null || !Number.isFinite(income)) add("renda", `Renda a partir de R$ ${settings.minIncome.toLocaleString("pt-BR")}`, "missing", "Renda não informada.");
  else add("renda", `Renda a partir de R$ ${settings.minIncome.toLocaleString("pt-BR")}`, income >= settings.minIncome ? "ok" : "nq", `R$ ${income.toLocaleString("pt-BR")}`);

  add("cartao", "Trabalha com cartão de crédito", input.hasCreditCard == null ? "missing" : input.hasCreditCard ? "ok" : "nq", input.hasCreditCard == null ? "Não informado." : input.hasCreditCard ? "Sim" : "Não");
  add("casa_propria", "Tem casa própria", input.ownsHome == null ? "missing" : input.ownsHome ? "ok" : "nq", input.ownsHome == null ? "Não informado." : input.ownsHome ? "Sim" : "Não");

  const nqItems = criteria.filter(c => c.status === "nq").length;
  const missing = criteria.filter(c => c.status === "missing").length;
  const outcome = nqItems === 0 ? "qualificado" : nqItems <= settings.maxItemsAccepted ? "nq_aceito" : "nt_perfil";
  const text = `NQ: ${nqItems} ${nqItems === 1 ? "item" : "itens"}`;
  return { criteria, nqItems, missing, outcome, label: missing ? `${text} (faltam ${missing} dados)` : text };
}

// ---------------------------------------------------------------------------------------------------------------------
// LGPD da ficha (parecer 17/10 + decisões do Lucas 16:14Z): o papel se destrói, a ficha digital nunca; ficha de quem não
// comprou sai da vista da sala e fica só com o administrativo; exportar com CPF é só de quem tem `export.pii`.
// Tudo abaixo é regra pura (sem banco) para o teste unitário cobrir sem MySQL. Dias e textos são provisórios e configuráveis.
// ---------------------------------------------------------------------------------------------------------------------

/** Papéis que continuam abrindo a ficha depois que ela sai da vista da sala ("administrativo", decisão do Lucas). */
export const ARCHIVED_SHEET_ROLES = ["admin", "finance"] as const;
export const canOpenArchivedSheet = (role: string | null | undefined) => (ARCHIVED_SHEET_ROLES as readonly string[]).includes(role ?? "");

/** Soma dias a uma data local AAAA-MM-DD (sem fuso: aritmética de calendário em UTC). */
export function addCalendarDays(day: string, days: number) {
  const base = new Date(`${day}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export type RoomVisibilityInput = {
  /** Dia da visita no calendário do projeto (check-in; sem check-in, o dia da criação). */
  visitDay: string | null;
  /** Hoje no calendário do projeto. */
  today: string;
  /** Dias extras em que a ficha ainda aparece para a sala depois do dia da visita (0 = só no dia). */
  roomVisibilityDays: number;
  commercialOutcome: "vendeu" | "caiu_em_mesa" | null | undefined;
};
export type RoomVisibility = { visibleToRoom: boolean; reason: "dia_da_visita" | "vendeu" | "arquivada"; lastRoomDay: string | null };

/**
 * A ficha de quem NÃO comprou sai da vista da sala depois do dia da visita (mais os dias configurados) e passa a abrir
 * só para admin e finance. VENDEU (aceite comercial) mantém a ficha visível: a venda segue no CRM. Nada é apagado.
 */
export function roomVisibility(input: RoomVisibilityInput): RoomVisibility {
  if (input.commercialOutcome === "vendeu") return { visibleToRoom: true, reason: "vendeu", lastRoomDay: null };
  if (!input.visitDay) return { visibleToRoom: true, reason: "dia_da_visita", lastRoomDay: null };
  const days = Number.isFinite(input.roomVisibilityDays) && input.roomVisibilityDays > 0 ? Math.floor(input.roomVisibilityDays) : 0;
  const lastRoomDay = addCalendarDays(input.visitDay, days);
  return input.today <= lastRoomDay ? { visibleToRoom: true, reason: "dia_da_visita", lastRoomDay } : { visibleToRoom: false, reason: "arquivada", lastRoomDay };
}

export type PaperStatus = "nao_impressa" | "em_circulacao" | "recolhida" | "destruida";
export type PaperCustody = { status: PaperStatus; overdue: boolean; deadlineDay: string | null };

/**
 * Estado do papel pela última impressão: em circulação até ser recolhido; recolhido até ser destruído. O prazo para destruir
 * conta do dia da impressão mais os dias configurados (0 = no mesmo dia); passou e não destruiu = atrasada.
 */
export function paperCustody(input: { printedDay: string | null; collectedAt: Date | null; destroyedAt: Date | null; today: string; destroyDeadlineDays: number }): PaperCustody {
  if (!input.printedDay) return { status: "nao_impressa", overdue: false, deadlineDay: null };
  const days = Number.isFinite(input.destroyDeadlineDays) && input.destroyDeadlineDays > 0 ? Math.floor(input.destroyDeadlineDays) : 0;
  const deadlineDay = addCalendarDays(input.printedDay, days);
  if (input.destroyedAt) return { status: "destruida", overdue: false, deadlineDay };
  return { status: input.collectedAt ? "recolhida" : "em_circulacao", overdue: input.today > deadlineDay, deadlineDay };
}

/**
 * Custódia da ficha inteira: cada impressão tem o próprio prazo (o gravado nela, ou o configurado hoje quando antiga).
 * Enquanto existir cópia não destruída, vale a pior: atrasada se QUALQUER cópia pendente passou do prazo, em circulação
 * se alguma ainda não foi recolhida, e o prazo mostrado é o mais cedo entre as pendentes. Todas destruídas = destruída.
 */
export function paperCustodyOfSheet(prints: Array<{ printedDay: string; collectedAt: Date | null; destroyedAt: Date | null; destroyDeadlineDays: number | null }>, today: string, fallbackDeadlineDays: number): PaperCustody {
  if (!prints.length) return { status: "nao_impressa", overdue: false, deadlineDay: null };
  const each = prints.map(print => ({ print, custody: paperCustody({ printedDay: print.printedDay, collectedAt: print.collectedAt, destroyedAt: print.destroyedAt, today, destroyDeadlineDays: print.destroyDeadlineDays ?? fallbackDeadlineDays }) }));
  const pending = each.filter(item => item.custody.status !== "destruida");
  if (!pending.length) return { status: "destruida", overdue: false, deadlineDay: each.map(item => item.custody.deadlineDay!).sort().at(-1) ?? null };
  return {
    status: pending.some(item => item.custody.status === "em_circulacao") ? "em_circulacao" : "recolhida",
    overdue: pending.some(item => item.custody.overdue),
    deadlineDay: pending.map(item => item.custody.deadlineDay!).sort()[0] ?? null,
  };
}

/** Acima deste número de impressões a ficha entra no alerta de reimpressão do painel (parecer A1.4). */
export const REPRINT_ALERT_THRESHOLD = 2;

/** Configurações de texto do aviso de privacidade: vazias até o Lucas/advogado mandarem; a ficha imprime o marcador entre colchetes. */
export const PRIVACY_TEXT_KEYS = ["privacy_controller_name", "privacy_controller_cnpj", "privacy_contact_channel", "privacy_full_text_url", "privacy_retention_text"] as const;
export type PrivacyTextKey = (typeof PRIVACY_TEXT_KEYS)[number];
export type PrivacySettings = Record<PrivacyTextKey, string>;

/**
 * Texto v1 do aviso de privacidade (parecer, seção 4): provisório, não aprovado por advogado. Campos vazios saem como
 * [●] para ninguém assinar um aviso com dado inventado. Não usa a palavra "consentimento": em sala de vendas o campo é "ciente".
 */
export function privacyNoticeText(settings: Partial<PrivacySettings>, destroyDeadlineDays = 0) {
  const pick = (key: PrivacyTextKey, placeholder: string) => (settings[key]?.trim() ? settings[key]!.trim() : placeholder);
  return `Os dados desta ficha (identificação, contato, CPF, renda, veículo, família e preferências de viagem) são tratados por ${pick("privacy_controller_name", "[RAZÃO SOCIAL DA OPERADORA]")}, CNPJ ${pick("privacy_controller_cnpj", "[●]")}, para realizar esta visita, avaliar a proposta comercial e, se houver interesse, dar seguimento ao contato. Base legal: procedimentos preliminares de contrato e legítimo interesse. Os dados podem ser compartilhados com os sistemas da operação (cadastro de visita, sala de vendas, CRM) e, em caso de contratação, com parceiros de pagamento e assinatura eletrônica. Guardamos os dados pelo prazo de ${pick("privacy_retention_text", "[●]")}; esta folha em papel é recolhida e destruída ${paperDestroyPromise(destroyDeadlineDays)}. Você pode pedir acesso, correção, informação sobre compartilhamento ou oposição ao tratamento pelo canal ${pick("privacy_contact_channel", "[canal do encarregado]")}. Texto completo em ${pick("privacy_full_text_url", "[endereço]")}.`;
}

/** Primeiro instante (UTC) do dia local AAAA-MM-DD no fuso dado; fusos com passo de 15 min cobertos. */
export function localDayStart(day: string, timezone: string, localDate: (value: Date, tz: string) => string) {
  // O dia local começa entre 26 h antes e 0 h depois do meio-dia UTC (fusos de -12 a +14); o primeiro instante que cai no dia é o início.
  const noonUtc = new Date(`${day}T12:00:00Z`).getTime();
  let start = new Date(noonUtc - 26 * 3600_000);
  for (let step = -26 * 4; step <= 0; step += 1) {
    const candidate = new Date(noonUtc + step * 900_000);
    if (localDate(candidate, timezone) === day) { start = candidate; break; }
  }
  return start;
}
