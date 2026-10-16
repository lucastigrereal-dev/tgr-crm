-- Rollback da migração 0059 (CRM-PK-04). Ordem importa: a FK usa o índice, então a FK sai primeiro.
-- Não há o que desfazer no backfill: a coluna inteira é removida.
ALTER TABLE `contracts` DROP FOREIGN KEY `contracts_resortId_resorts_id_fk`;
--> statement-breakpoint
DROP INDEX `contracts_resort_idx` ON `contracts`;
--> statement-breakpoint
ALTER TABLE `contracts` DROP COLUMN `resortId`;
