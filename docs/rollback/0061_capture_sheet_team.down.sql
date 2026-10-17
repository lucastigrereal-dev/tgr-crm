-- Rollback da migração 0061 (TSE x CRM: ficha com código do casal, equipe por papel, campos novos).
-- Perde o que foi gravado nas tabelas e colunas novas; as fichas e o resto do CRM não mudam.
-- A última linha tira a 0061 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
DROP TABLE `capture_sheet_prints`;
--> statement-breakpoint
DROP TABLE `capture_team_members`;
--> statement-breakpoint
DROP TABLE `capture_team_roles`;
--> statement-breakpoint
ALTER TABLE `capture_records` DROP INDEX `captures_couple_code_unique`;
--> statement-breakpoint
ALTER TABLE `capture_records` DROP COLUMN `coupleCode`, DROP COLUMN `secondVehicleModel`, DROP COLUMN `secondVehicleYear`, DROP COLUMN `retiredPrimary`, DROP COLUMN `retiredPartner`, DROP COLUMN `guest1Name`, DROP COLUMN `guest2Name`, DROP COLUMN `pepOffered`, DROP COLUMN `pepOfferedBy`, DROP COLUMN `pepResult`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792245940048;
