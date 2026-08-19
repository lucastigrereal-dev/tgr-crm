export type ImportKind = "customers" | "contracts";
export type ImportIssue = { line: number; field: string; message: string };

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

const compact = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const cell = (value: string | undefined) => value?.trim() || null;
const documentValue = (value: string | undefined) => (value ?? "").replace(/\D/g, "");

function parseTable(content: string) {
  const source = content.replace(/^\uFEFF/, "");
  const delimiter = (source.split(/\r?\n/, 1)[0]?.match(/;/g)?.length ?? 0) > (source.split(/\r?\n/, 1)[0]?.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (char === '"' && quoted && next === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { row.push(field); field = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = ""; continue;
    }
    field += char;
  }
  row.push(field); if (row.some(value => value.trim())) rows.push(row);
  const headers = (rows.shift() ?? []).map(compact);
  return rows.map((values, index) => ({ line: index + 2, values: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])) }));
}

function amount(value: string | undefined) {
  const raw = (value ?? "").trim().replace(/\s/g, "");
  if (!raw) return Number.NaN;
  return Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
}

function dateValue(value: string | undefined) { return /^\d{4}-\d{2}-\d{2}$/.test((value ?? "").trim()) ? (value ?? "").trim() : null; }

export function parseCustomersCsv(content: string) {
  const issues: ImportIssue[] = []; const records: CustomerImportRow[] = []; const seenDocuments = new Set<string>();
  for (const { line, values } of parseTable(content)) {
    const fullName = cell(values.nome_completo) ?? ""; const documentNumber = documentValue(values.documento);
    const email = cell(values.email); const birthDate = dateValue(values.data_nascimento); const statusSource = compact(values.status ?? "prospect");
    const status = ({ ativo: "active", active: "active", inativo: "inactive", inactive: "inactive", prospect: "prospect", prospecto: "prospect" } as const)[statusSource];
    if (fullName.length < 3) issues.push({ line, field: "nome_completo", message: "Informe nome completo com ao menos 3 caracteres." });
    if (!documentNumber) issues.push({ line, field: "documento", message: "Informe o documento do associado." });
    if (documentNumber && seenDocuments.has(documentNumber)) issues.push({ line, field: "documento", message: "Documento duplicado no próprio arquivo." });
    if (documentNumber) seenDocuments.add(documentNumber);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) issues.push({ line, field: "email", message: "E-mail inválido." });
    if (cell(values.data_nascimento) && !birthDate) issues.push({ line, field: "data_nascimento", message: "Use AAAA-MM-DD." });
    if (!status) issues.push({ line, field: "status", message: "Use prospect, ativo ou inativo." });
    records.push({ fullName, documentNumber, email, phone: cell(values.telefone), birthDate, maritalStatus: cell(values.estado_civil), occupation: cell(values.profissao), zipCode: cell(values.cep), address: cell(values.endereco), addressNumber: cell(values.numero), complement: cell(values.complemento), neighborhood: cell(values.bairro), city: cell(values.cidade), state: cell(values.uf)?.toUpperCase() ?? null, acquisitionSource: cell(values.origem), status: status ?? "prospect", notes: cell(values.observacoes) });
  }
  return { records, issues };
}

export function parseContractsCsv(content: string) {
  const issues: ImportIssue[] = []; const records: ContractImportRow[] = []; const seenNumbers = new Set<string>();
  for (const { line, values } of parseTable(content)) {
    const number = cell(values.numero_contrato) ?? ""; const customerDocument = documentValue(values.documento_associado); const totalAmount = amount(values.valor_total); const installmentCount = Number(values.quantidade_parcelas);
    const usageModel = ({ semana_fixa: "fixed_week", fixed_week: "fixed_week", semana_flexivel: "flexible_week", flexible_week: "flexible_week", pontos: "points", points: "points" } as const)[compact(values.modelo_uso ?? "")];
    const status = ({ rascunho: "draft", draft: "draft", pendente_assinatura: "pending_signature", pending_signature: "pending_signature", ativo: "active", active: "active", inadimplente: "overdue", overdue: "overdue", cancelado: "cancelled", cancelled: "cancelled", encerrado: "closed", closed: "closed" } as const)[compact(values.status ?? "rascunho")];
    const firstDueDate = dateValue(values.primeiro_vencimento);
    if (number.length < 3) issues.push({ line, field: "numero_contrato", message: "Informe um número de contrato válido." });
    if (number && seenNumbers.has(number)) issues.push({ line, field: "numero_contrato", message: "Contrato duplicado no próprio arquivo." });
    if (number) seenNumbers.add(number);
    if (!customerDocument) issues.push({ line, field: "documento_associado", message: "Informe o documento do associado." });
    if (!usageModel) issues.push({ line, field: "modelo_uso", message: "Use semana_fixa, semana_flexivel ou pontos." });
    if (!status) issues.push({ line, field: "status", message: "Status contratual inválido." });
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) issues.push({ line, field: "valor_total", message: "Informe valor total positivo." });
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 360) issues.push({ line, field: "quantidade_parcelas", message: "Informe entre 1 e 360 parcelas." });
    if (!firstDueDate) issues.push({ line, field: "primeiro_vencimento", message: "Use AAAA-MM-DD." });
    records.push({ number, customerDocument, usageModel: usageModel ?? "fixed_week", status: status ?? "draft", totalAmount, installmentCount, firstDueDate: firstDueDate ?? "", sellerEmail: cell(values.email_vendedor)?.toLowerCase() ?? null, notes: cell(values.observacoes) });
  }
  return { records, issues };
}
