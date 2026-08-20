export type ImportKind = "customers" | "contracts" | "units";
export type ImportIssue = { line: number; field: string; message: string };
export type CsvColumnMapping = Record<string, string>;

export type CustomerImportRow = {
  fullName: string; documentNumber: string; email: string | null; phone: string | null; birthDate: string | null;
  maritalStatus: string | null; occupation: string | null; zipCode: string | null; address: string | null; addressNumber: string | null;
  complement: string | null; neighborhood: string | null; city: string | null; state: string | null; acquisitionSource: string | null;
  status: "active" | "inactive" | "prospect"; notes: string | null;
};

export type ContractImportRow = {
  number: string; customerDocument: string; usageModel: "fixed_week" | "flexible_week" | "points";
  status: "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed";
  totalAmount: number; installmentCount: number; firstDueDate: string; sellerEmail: string | null; notes: string | null;
};

export type UnitImportRow = {
  resortName: string; resortCity: string | null; resortState: string | null; resortStatus: "active" | "inactive";
  code: string; category: string | null; capacity: number; beds: number; status: "active" | "maintenance" | "inactive";
};

const compact = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const cell = (value: string | undefined) => value?.trim() || null;
const documentValue = (value: string | undefined) => (value ?? "").replace(/\D/g, "");

const customerFields = ["nome_completo", "documento", "email", "telefone", "data_nascimento", "estado_civil", "profissao", "cep", "endereco", "numero", "complemento", "bairro", "cidade", "uf", "origem", "status", "observacoes"] as const;
const contractFields = ["numero_contrato", "documento_associado", "modelo_uso", "status", "valor_total", "quantidade_parcelas", "primeiro_vencimento", "email_vendedor", "observacoes"] as const;
const unitFields = ["nome_empreendimento", "cidade_empreendimento", "uf_empreendimento", "status_empreendimento", "codigo_unidade", "categoria", "capacidade", "camas", "status_unidade"] as const;
const aliases: Record<string, string[]> = {
  nome_completo: ["nome", "nome_completo", "nome_do_cliente", "nome_do_associado", "associado", "cliente"], documento: ["cpf", "documento", "cpf_cnpj", "documento_cliente"], email: ["email", "e_mail", "email_associado"], telefone: ["telefone", "celular", "fone", "whatsapp"], data_nascimento: ["data_nascimento", "nascimento", "dt_nascimento"], estado_civil: ["estado_civil"], profissao: ["profissao", "ocupacao"], cep: ["cep"], endereco: ["endereco", "logradouro", "rua"], numero: ["numero", "numero_endereco"], complemento: ["complemento"], bairro: ["bairro"], cidade: ["cidade", "municipio"], uf: ["uf", "estado"], origem: ["origem", "fonte", "canal"], observacoes: ["observacoes", "observacao", "notas"],
  numero_contrato: ["numero_contrato", "contrato", "numero", "nr_contrato"], documento_associado: ["documento_associado", "cpf_associado", "cpf", "documento", "documento_cliente"], modelo_uso: ["modelo_uso", "uso", "tipo_uso"], valor_total: ["valor_total", "valor", "vgv", "total"], quantidade_parcelas: ["quantidade_parcelas", "parcelas", "qtd_parcelas"], primeiro_vencimento: ["primeiro_vencimento", "vencimento", "data_primeira_parcela"], email_vendedor: ["email_vendedor", "vendedor_email", "email_consultor"], status: ["status", "situacao"],
  nome_empreendimento: ["nome_empreendimento", "empreendimento", "resort", "hotel"], cidade_empreendimento: ["cidade_empreendimento", "cidade_resort", "cidade"], uf_empreendimento: ["uf_empreendimento", "uf_resort", "uf", "estado"], status_empreendimento: ["status_empreendimento", "status_resort"], codigo_unidade: ["codigo_unidade", "unidade", "codigo", "apartamento", "apt", "numero_unidade"], categoria: ["categoria", "tipo_unidade", "tipo"], capacidade: ["capacidade", "hospedes", "capacidade_hospedes"], camas: ["camas", "quantidade_camas", "qtd_camas"], status_unidade: ["status_unidade", "situacao_unidade"],
};

type RawCsvTable = { headers: string[]; values: string[][]; delimiter: string };
function parseRawTable(content: string): RawCsvTable {
  const source = content.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (char === '"' && quoted && next === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { row.push(field); field = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") index += 1; row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  row.push(field); if (row.some(value => value.trim())) rows.push(row);
  return { headers: rows.shift() ?? [], values: rows, delimiter };
}

function parseTable(content: string) {
  const raw = parseRawTable(content); const headers = raw.headers.map(compact);
  return raw.values.map((values, index) => ({ line: index + 2, values: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])) }));
}

const csvCell = (value: string) => /[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export function suggestCsvMapping(content: string, kind: ImportKind) {
  const raw = parseRawTable(content); const fields = kind === "customers" ? customerFields : kind === "contracts" ? contractFields : unitFields;
  const suggestedMapping = Object.fromEntries(fields.map(field => {
    const header = raw.headers.find(source => (aliases[field] ?? [field]).includes(compact(source)));
    return [field, header ?? ""];
  }));
  return { sourceHeaders: raw.headers, suggestedMapping, targetFields: fields, requiredFields: kind === "customers" ? ["nome_completo", "documento"] : kind === "contracts" ? ["numero_contrato", "documento_associado", "modelo_uso", "valor_total", "quantidade_parcelas", "primeiro_vencimento"] : ["nome_empreendimento", "codigo_unidade"] };
}

export function applyCsvMapping(content: string, mapping?: CsvColumnMapping) {
  if (!mapping || Object.keys(mapping).length === 0) return content;
  const raw = parseRawTable(content); const entries = Object.entries(mapping).filter(([, source]) => source?.trim());
  if (!entries.length) return content;
  const positions = new Map(raw.headers.map((header, index) => [compact(header), index]));
  const headers = entries.map(([field]) => field); const rows = raw.values.map(row => entries.map(([, source]) => row[positions.get(compact(source)) ?? -1] ?? ""));
  return [headers.join(";"), ...rows.map(row => row.map(csvCell).join(";"))].join("\n");
}

export function buildImportErrorReport(issues: ImportIssue[]) {
  return ["linha;campo;mensagem", ...issues.map(issue => [String(issue.line), issue.field, issue.message].map(csvCell).join(";"))].join("\n");
}

function amount(value: string | undefined) { const raw = (value ?? "").trim().replace(/\s/g, ""); if (!raw) return Number.NaN; return Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw); }
function dateValue(value: string | undefined) { return /^\d{4}-\d{2}-\d{2}$/.test((value ?? "").trim()) ? (value ?? "").trim() : null; }

export function parseCustomersCsv(content: string) {
  const issues: ImportIssue[] = []; const records: CustomerImportRow[] = []; const seenDocuments = new Set<string>();
  for (const { line, values } of parseTable(content)) {
    const fullName = cell(values.nome_completo) ?? ""; const documentNumber = documentValue(values.documento); const email = cell(values.email); const birthDate = dateValue(values.data_nascimento); const statusSource = compact(values.status ?? "prospect"); const status = ({ ativo: "active", active: "active", inativo: "inactive", inactive: "inactive", prospect: "prospect", prospecto: "prospect" } as const)[statusSource];
    if (fullName.length < 3) issues.push({ line, field: "nome_completo", message: "Informe nome completo com ao menos 3 caracteres." }); if (!documentNumber) issues.push({ line, field: "documento", message: "Informe o documento do associado." }); if (documentNumber && seenDocuments.has(documentNumber)) issues.push({ line, field: "documento", message: "Documento duplicado no próprio arquivo." }); if (documentNumber) seenDocuments.add(documentNumber); if (email && !/^\S+@\S+\.\S+$/.test(email)) issues.push({ line, field: "email", message: "E-mail inválido." }); if (cell(values.data_nascimento) && !birthDate) issues.push({ line, field: "data_nascimento", message: "Use AAAA-MM-DD." }); if (!status) issues.push({ line, field: "status", message: "Use prospect, ativo ou inativo." });
    records.push({ fullName, documentNumber, email, phone: cell(values.telefone), birthDate, maritalStatus: cell(values.estado_civil), occupation: cell(values.profissao), zipCode: cell(values.cep), address: cell(values.endereco), addressNumber: cell(values.numero), complement: cell(values.complemento), neighborhood: cell(values.bairro), city: cell(values.cidade), state: cell(values.uf)?.toUpperCase() ?? null, acquisitionSource: cell(values.origem), status: status ?? "prospect", notes: cell(values.observacoes) });
  }
  return { records, issues };
}

export function parseContractsCsv(content: string) {
  const issues: ImportIssue[] = []; const records: ContractImportRow[] = []; const seenNumbers = new Set<string>();
  for (const { line, values } of parseTable(content)) {
    const number = cell(values.numero_contrato) ?? ""; const customerDocument = documentValue(values.documento_associado); const totalAmount = amount(values.valor_total); const installmentCount = Number(values.quantidade_parcelas); const usageModel = ({ semana_fixa: "fixed_week", fixed_week: "fixed_week", semana_flexivel: "flexible_week", flexible_week: "flexible_week", pontos: "points", points: "points" } as const)[compact(values.modelo_uso ?? "")]; const status = ({ rascunho: "draft", draft: "draft", pendente_assinatura: "pending_signature", pending_signature: "pending_signature", ativo: "active", active: "active", inadimplente: "overdue", overdue: "overdue", cancelado: "cancelled", cancelled: "cancelled", encerrado: "closed", closed: "closed" } as const)[compact(values.status ?? "rascunho")]; const firstDueDate = dateValue(values.primeiro_vencimento);
    if (number.length < 3) issues.push({ line, field: "numero_contrato", message: "Informe um número de contrato válido." }); if (number && seenNumbers.has(number)) issues.push({ line, field: "numero_contrato", message: "Contrato duplicado no próprio arquivo." }); if (number) seenNumbers.add(number); if (!customerDocument) issues.push({ line, field: "documento_associado", message: "Informe o documento do associado." }); if (!usageModel) issues.push({ line, field: "modelo_uso", message: "Use semana_fixa, semana_flexivel ou pontos." }); if (!status) issues.push({ line, field: "status", message: "Status contratual inválido." }); if (!Number.isFinite(totalAmount) || totalAmount <= 0) issues.push({ line, field: "valor_total", message: "Informe valor total positivo." }); if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 360) issues.push({ line, field: "quantidade_parcelas", message: "Informe entre 1 e 360 parcelas." }); if (!firstDueDate) issues.push({ line, field: "primeiro_vencimento", message: "Use AAAA-MM-DD." });
    records.push({ number, customerDocument, usageModel: usageModel ?? "fixed_week", status: status ?? "draft", totalAmount, installmentCount, firstDueDate: firstDueDate ?? "", sellerEmail: cell(values.email_vendedor)?.toLowerCase() ?? null, notes: cell(values.observacoes) });
  }
  return { records, issues };
}

export function parseUnitsCsv(content: string) {
  const issues: ImportIssue[] = []; const records: UnitImportRow[] = []; const seenUnitKeys = new Set<string>();
  const resortStatuses: Record<string, UnitImportRow["resortStatus"]> = { ativo: "active", active: "active", inativo: "inactive", inactive: "inactive" };
  const unitStatuses: Record<string, UnitImportRow["status"]> = { ativo: "active", active: "active", manutencao: "maintenance", maintenance: "maintenance", inativo: "inactive", inactive: "inactive" };
  for (const { line, values } of parseTable(content)) {
    const resortName = cell(values.nome_empreendimento) ?? ""; const code = cell(values.codigo_unidade) ?? "";
    const capacitySource = cell(values.capacidade); const bedsSource = cell(values.camas);
    const capacity = capacitySource ? Number(capacitySource) : 2; const beds = bedsSource ? Number(bedsSource) : 1;
    const resortStatus = resortStatuses[compact(values.status_empreendimento ?? "ativo")]; const status = unitStatuses[compact(values.status_unidade ?? "ativo")];
    const unitKey = `${resortName.toLocaleLowerCase("pt-BR")}::${code.toLocaleLowerCase("pt-BR")}`;
    if (resortName.length < 3) issues.push({ line, field: "nome_empreendimento", message: "Informe o nome do empreendimento com ao menos 3 caracteres." });
    if (code.length < 1) issues.push({ line, field: "codigo_unidade", message: "Informe o código da unidade." });
    if (resortName && code && seenUnitKeys.has(unitKey)) issues.push({ line, field: "codigo_unidade", message: "Unidade duplicada no próprio arquivo para este empreendimento." });
    if (resortName && code) seenUnitKeys.add(unitKey);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) issues.push({ line, field: "capacidade", message: "Informe capacidade entre 1 e 50 hóspedes." });
    if (!Number.isInteger(beds) || beds < 1 || beds > 20) issues.push({ line, field: "camas", message: "Informe entre 1 e 20 camas." });
    if (!resortStatus) issues.push({ line, field: "status_empreendimento", message: "Use ativo ou inativo." });
    if (!status) issues.push({ line, field: "status_unidade", message: "Use ativo, manutencao ou inativo." });
    records.push({ resortName, resortCity: cell(values.cidade_empreendimento), resortState: cell(values.uf_empreendimento)?.toUpperCase() ?? null, resortStatus: resortStatus ?? "active", code, category: cell(values.categoria), capacity, beds, status: status ?? "active" });
  }
  return { records, issues };
}
