import mysql from "mysql2/promise";
const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error("E2E_DATABASE_URL é obrigatória.");
const db = await mysql.createConnection(url);
await db.query("SET FOREIGN_KEY_CHECKS=0");
for (const table of ["domain_events", "audit_logs", "csv_import_items", "csv_import_batches", "reservation_guests", "reservation_waitlist", "reservations", "installments", "contracts", "opportunities", "units", "resorts", "customers", "users"]) await db.query(`DELETE FROM ${table}`);
await db.query("SET FOREIGN_KEY_CHECKS=1");
await db.end();
console.log("Seed E2E isolado removido.");
