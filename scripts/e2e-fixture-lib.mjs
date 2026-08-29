import { createHash } from "node:crypto";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DATABASE_PATTERN = /^[a-z0-9_]+$/;

function requireRunId(env) {
  const raw = env.E2E_RUN_ID;
  if (!raw) {
    throw new Error("E2E_RUN_ID é obrigatório para identificar e destruir somente a fixture deste run.");
  }
  if (!RUN_ID_PATTERN.test(raw)) {
    throw new Error("E2E_RUN_ID deve ter 1–32 caracteres alfanuméricos, hífen ou underscore.");
  }
  return raw;
}

function normalizeRunId(runId) {
  return runId.toLowerCase().replace(/-/g, "_");
}

function numericSeed(runId) {
  const digest = createHash("sha256").update(runId).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % 100_000_000;
}

function sequence(base, offset, width) {
  return String((base + offset) % 10 ** width).padStart(width, "0");
}

export function quoteMysqlIdentifier(identifier) {
  if (!DATABASE_PATTERN.test(identifier)) {
    throw new Error("Identificador MySQL E2E inválido.");
  }
  return `\`${identifier}\``;
}

export function getE2EFixtureContext(env, isolation) {
  const runId = requireRunId(env);
  const normalizedRunId = normalizeRunId(runId);
  const databaseName = `tgr_crm_${normalizedRunId}_e2e`;

  if (isolation.database !== databaseName) {
    throw new Error(
      `E2E_DATABASE_URL deve apontar para ${databaseName} quando E2E_RUN_ID=${runId}.`,
    );
  }

  const prefix = `E2E-TGR-${runId}-`;
  const seed = numericSeed(runId);
  const document = offset => `99${sequence(seed, offset, 9)}`;
  const phone = offset => `119${sequence(seed, offset, 8)}`;
  const serverUrl = new URL(isolation.url);
  serverUrl.pathname = "/";

  const fixture = {
    runId,
    normalizedRunId,
    databaseName,
    quotedDatabaseName: quoteMysqlIdentifier(databaseName),
    serverUrl: serverUrl.toString(),
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
  };

  const configuredOwner = env.OWNER_OPEN_ID || fixture.ownerOpenId;
  if (configuredOwner !== fixture.ownerOpenId) {
    throw new Error(`OWNER_OPEN_ID deve ser exatamente ${fixture.ownerOpenId} neste run E2E.`);
  }

  return fixture;
}
