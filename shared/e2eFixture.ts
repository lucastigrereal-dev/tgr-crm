import { createHash } from "node:crypto";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function requireRunId(env: NodeJS.ProcessEnv) {
  const raw = env.E2E_RUN_ID;
  if (!raw) throw new Error("E2E_RUN_ID é obrigatório para a homologação isolada.");
  if (!RUN_ID_PATTERN.test(raw)) {
    throw new Error("E2E_RUN_ID deve ter 1–32 caracteres alfanuméricos, hífen ou underscore.");
  }
  return raw;
}

function sequence(base: number, offset: number, width: number) {
  return String((base + offset) % 10 ** width).padStart(width, "0");
}

export function getE2EFixture(env: NodeJS.ProcessEnv = process.env) {
  const runId = requireRunId(env);
  const normalizedRunId = runId.toLowerCase().replace(/-/g, "_");
  const prefix = `E2E-TGR-${runId}-`;
  const digest = createHash("sha256").update(runId).digest("hex");
  const seed = Number.parseInt(digest.slice(0, 8), 16) % 100_000_000;
  const document = (offset: number) => `99${sequence(seed, offset, 9)}`;
  const phone = (offset: number) => `119${sequence(seed, offset, 8)}`;

  return {
    runId,
    normalizedRunId,
    databaseName: `tgr_crm_${normalizedRunId}_e2e`,
    prefix,
    ownerOpenId: `${prefix}OWNER`,
    ownerName: `${prefix}Owner`,
    ownerEmail: `${normalizedRunId}.owner@e2e.invalid`,
    resortName: `${prefix}Resort`,
    unitGuestCode: `${normalizedRunId.toUpperCase()}-101`,
    unitWaitlistCode: `${normalizedRunId.toUpperCase()}-102`,
    reservationCustomerName: `${prefix}Reserva Associado`,
    commercialCustomerName: `${prefix}Comercial Associado`,
    roomTourCustomerName: `${prefix}Sala Tour`,
    roomNoTourCustomerName: `${prefix}Sala Sem Tour`,
    importCustomerName: `${prefix}Importado`,
    guestName: `${prefix}Acompanhante`,
    opportunityTitle: `${prefix}Proposta Filtrada`,
    contractNumber: `${prefix}CTR-001`,
    salesRoom: `${prefix}Sala`,
    salesTable: `${normalizedRunId.toUpperCase()}-08`,
    documents: {
      reservation: document(1),
      commercial: document(2),
      roomTour: document(3),
      roomNoTour: document(4),
      imported: document(99),
    },
    phones: {
      reservation: phone(1),
      commercial: phone(2),
      roomTour: phone(3),
      roomNoTour: phone(4),
      imported: phone(99),
    },
  } as const;
}
