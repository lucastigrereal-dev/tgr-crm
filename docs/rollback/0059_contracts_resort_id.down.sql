-- Rollback da migração 0059 (CRM-PK-04). Ordem importa: a FK usa o índice, então a FK sai primeiro.
-- A última linha tira a 0059 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração e a coluna não voltaria.
-- Não há o que desfazer no backfill: a coluna inteira é removida.
ALTER TABLE `contracts` DROP FOREIGN KEY `contracts_resortId_resorts_id_fk`;
--> statement-breakpoint
DROP INDEX `contracts_resort_idx` ON `contracts`;
--> statement-breakpoint
ALTER TABLE `contracts` DROP COLUMN `resortId`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792181487893;
