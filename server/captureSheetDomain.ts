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
  vehicleKind?: "carro" | "moto" | null;
  vehicleYear?: number | null;
  secondVehicleKind?: "carro" | "moto" | null;
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
  else if (/namor|solteir|noiv|ficante/.test(status)) add("relacionamento", "Casado ou união estável", "nq", input.relationshipStatus!);
  else if (/casad|uniao|estavel|marit|convive|amasi/.test(status)) add("relacionamento", "Casado ou união estável", "ok", input.relationshipStatus!);
  else add("relacionamento", "Casado ou união estável", "missing", `Relacionamento "${input.relationshipStatus}" não reconhecido: o gerente confirma.`);

  const months = input.relationshipYears == null && input.relationshipMonths == null ? null : (input.relationshipYears ?? 0) * 12 + (input.relationshipMonths ?? 0);
  if (months == null) add("tempo_relacionamento", `Relacionamento acima de ${settings.minRelationshipMonths} meses`, "missing", "Tempo de relacionamento não informado.");
  else add("tempo_relacionamento", `Relacionamento acima de ${settings.minRelationshipMonths} meses`, months > settings.minRelationshipMonths ? "ok" : "nq", `${months} meses`);

  const vehicles = [{ kind: input.vehicleKind, year: input.vehicleYear }, { kind: input.secondVehicleKind, year: input.secondVehicleYear }];
  const label = `Carro de ${settings.minVehicleYear} ou mais novo`;
  if (vehicles.some(v => v.kind === "carro" && v.year != null && v.year >= settings.minVehicleYear)) add("veiculo", label, "ok", "Carro dentro do ano mínimo.");
  else if (vehicles.every(v => v.kind == null)) add("veiculo", label, "missing", "Tipo do veículo não informado (carro ou moto).");
  else if (vehicles.some(v => v.kind === "carro" && v.year == null)) add("veiculo", label, "missing", "Ano do carro não informado.");
  else add("veiculo", label, "nq", vehicles.every(v => v.kind !== "carro") ? "Só moto (moto não vale)." : "Carro mais velho que o ano mínimo.");

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
