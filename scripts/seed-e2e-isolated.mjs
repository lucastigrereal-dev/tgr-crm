import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { assertIsolatedE2EEnvironment } from "./e2e-isolation-lib.mjs";
import { getE2EFixtureContext } from "./e2e-fixture-lib.mjs";

const FIXTURE_FAMILY = "E2E-TGR-";
const isolation = assertIsolatedE2EEnvironment();
const fixture = getE2EFixtureContext(process.env, isolation);
if (!fixture.prefix.startsWith(FIXTURE_FAMILY)) {
  throw new Error("Família de fixture E2E inválida.");
}

function dateFromToday(offsetDays) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const receiptPath =
  process.env.E2E_RECEIPT_PATH ||
  path.join("e2e", ".runtime", `receipt-${fixture.normalizedRunId}.json`);
const db = await mysql.createConnection(isolation.url);

try {
  const [existingRows] = await db.execute(
    "SELECT id FROM contracts WHERE number = ? LIMIT 1",
    [fixture.contractNumber],
  );
  const existingContract = existingRows[0];
  if (existingContract) {
    const receipt = {
      runId: fixture.runId,
      database: fixture.databaseName,
      contractId: existingContract.id,
      ownerOpenId: fixture.ownerOpenId,
      reused: true,
    };
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ event: "e2e.seed.reused", ...receipt }));
    await db.end();
    process.exit(0);
  }

  await db.beginTransaction();
  await db.execute(
    "INSERT INTO users (openId, name, email, loginMethod, role) VALUES (?, ?, ?, 'e2e', 'admin') ON DUPLICATE KEY UPDATE role='admin', name=VALUES(name), email=VALUES(email)",
    [fixture.ownerOpenId, fixture.ownerName, fixture.ownerEmail],
  );
  const [ownerRows] = await db.execute(
    "SELECT id FROM users WHERE openId = ? LIMIT 1",
    [fixture.ownerOpenId],
  );
  const ownerId = ownerRows[0]?.id;
  if (!ownerId) throw new Error("Owner E2E não foi persistido.");

  await db.execute(
    "INSERT INTO resorts (name, city, state, status) VALUES (?, 'Natal', 'RN', 'active')",
    [fixture.resortName],
  );
  const [resortRows] = await db.execute(
    "SELECT id FROM resorts WHERE name = ? ORDER BY id DESC LIMIT 1",
    [fixture.resortName],
  );
  const resortId = resortRows[0]?.id;
  if (!resortId) throw new Error("Empreendimento E2E não foi persistido.");

  await db.execute(
    "INSERT INTO units (resortId, code, category, capacity, beds, status) VALUES (?, ?, 'Suite', 4, 2, 'active'), (?, ?, 'Suite', 4, 2, 'active')",
    [resortId, fixture.unitGuestCode, resortId, fixture.unitWaitlistCode],
  );
  const [unitRows] = await db.execute(
    "SELECT id, code FROM units WHERE resortId = ? AND code IN (?, ?) ORDER BY id",
    [resortId, fixture.unitGuestCode, fixture.unitWaitlistCode],
  );
  const unitForGuest = unitRows.find(row => row.code === fixture.unitGuestCode)?.id;
  const unitForWaitlist = unitRows.find(row => row.code === fixture.unitWaitlistCode)?.id;
  if (!unitForGuest || !unitForWaitlist) {
    throw new Error("Unidades E2E não foram persistidas.");
  }

  const customers = [
    {
      name: fixture.reservationCustomerName,
      document: fixture.documents.reservation,
      email: `${fixture.normalizedRunId}.reserva@e2e.invalid`,
      phone: fixture.phones.reservation,
      status: "active",
    },
    {
      name: fixture.commercialCustomerName,
      document: fixture.documents.commercial,
      email: `${fixture.normalizedRunId}.comercial@e2e.invalid`,
      phone: fixture.phones.commercial,
      status: "active",
    },
    {
      name: fixture.roomTourCustomerName,
      document: fixture.documents.roomTour,
      email: `${fixture.normalizedRunId}.tour@e2e.invalid`,
      phone: fixture.phones.roomTour,
      status: "prospect",
    },
    {
      name: fixture.roomNoTourCustomerName,
      document: fixture.documents.roomNoTour,
      email: `${fixture.normalizedRunId}.sem-tour@e2e.invalid`,
      phone: fixture.phones.roomNoTour,
      status: "prospect",
    },
  ];

  for (const customer of customers) {
    await db.execute(
      "INSERT INTO customers (fullName, documentNumber, email, phone, city, state, status) VALUES (?, ?, ?, ?, 'Natal', 'RN', ?)",
      [
        customer.name,
        customer.document,
        customer.email,
        customer.phone,
        customer.status,
      ],
    );
  }

  const [customerRows] = await db.execute(
    "SELECT id, documentNumber FROM customers WHERE documentNumber IN (?, ?, ?, ?)",
    [
      fixture.documents.reservation,
      fixture.documents.commercial,
      fixture.documents.roomTour,
      fixture.documents.roomNoTour,
    ],
  );
  const customerId = document =>
    customerRows.find(row => row.documentNumber === document)?.id;
  const reservationCustomerId = customerId(fixture.documents.reservation);
  const commercialCustomerId = customerId(fixture.documents.commercial);
  const roomTourCustomerId = customerId(fixture.documents.roomTour);
  const roomNoTourCustomerId = customerId(fixture.documents.roomNoTour);
  if (
    !reservationCustomerId ||
    !commercialCustomerId ||
    !roomTourCustomerId ||
    !roomNoTourCustomerId
  ) {
    throw new Error("Clientes E2E não foram persistidos.");
  }

  const today = dateFromToday(0);
  await db.execute(
    "INSERT INTO capture_records (customerId, promoterId, salesRoom, captureLocation, scheduledAt, presentationStatus, qualificationStatus) VALUES (?, ?, ?, 'E2E-TGR', CONCAT(?, ' 10:00:00'), 'scheduled', 'qualified'), (?, ?, ?, 'E2E-TGR', CONCAT(?, ' 10:15:00'), 'scheduled', 'qualified')",
    [
      roomTourCustomerId,
      ownerId,
      fixture.salesRoom,
      today,
      roomNoTourCustomerId,
      ownerId,
      fixture.salesRoom,
      today,
    ],
  );

  await db.execute(
    "INSERT INTO contracts (number, customerId, sellerId, usageModel, status, totalAmount, activatedAt) VALUES (?, ?, ?, 'flexible_week', 'active', 12000, NOW())",
    [fixture.contractNumber, reservationCustomerId, ownerId],
  );
  const [contractRows] = await db.execute(
    "SELECT id FROM contracts WHERE number = ? LIMIT 1",
    [fixture.contractNumber],
  );
  const contractId = contractRows[0]?.id;
  if (!contractId) throw new Error("Contrato E2E não foi persistido.");

  await db.execute(
    "INSERT INTO reservations (customerId, contractId, unitId, checkIn, checkOut, adults, status, createdByUserId) VALUES (?, ?, ?, ?, ?, 2, 'confirmed', ?)",
    [
      reservationCustomerId,
      contractId,
      unitForGuest,
      dateFromToday(0),
      dateFromToday(3),
      ownerId,
    ],
  );
  const [reservationRows] = await db.execute(
    "SELECT id FROM reservations WHERE contractId = ? ORDER BY id DESC LIMIT 1",
    [contractId],
  );
  const reservationId = reservationRows[0]?.id;
  if (!reservationId) throw new Error("Reserva E2E não foi persistida.");

  await db.execute(
    "INSERT INTO reservation_guests (reservationId, fullName, relationship) VALUES (?, ?, 'Cônjuge')",
    [reservationId, fixture.guestName],
  );
  await db.execute(
    "INSERT INTO reservation_waitlist (customerId, contractId, resortId, desiredCheckIn, desiredCheckOut, partySize, priorityScore, status, createdByUserId) VALUES (?, ?, ?, ?, ?, 2, 10, 'waiting', ?)",
    [
      reservationCustomerId,
      contractId,
      resortId,
      dateFromToday(10),
      dateFromToday(14),
      ownerId,
    ],
  );
  await db.execute(
    "INSERT INTO opportunities (customerId, sellerId, title, stage, source, expectedAmount, probability) VALUES (?, ?, ?, 'proposal', 'e2e-tgr', 15000, 70)",
    [commercialCustomerId, ownerId, fixture.opportunityTitle],
  );

  await db.commit();

  const receipt = {
    runId: fixture.runId,
    database: fixture.databaseName,
    contractId,
    ownerOpenId: fixture.ownerOpenId,
    resortId,
    unitForWaitlist,
    reused: false,
  };
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "e2e.seed.created", ...receipt }));
} catch (error) {
  await db.rollback().catch(() => undefined);
  throw error;
} finally {
  await db.end().catch(() => undefined);
}
