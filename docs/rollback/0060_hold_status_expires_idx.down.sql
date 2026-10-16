-- Rollback da migração 0060 (CRM-PK-11): remove o índice e tira a 0060 da tabela de controle do drizzle.
-- Vale se a 0060 ainda for a última migração aplicada (o drizzle reaplica só o que é mais novo que a última linha).
DROP INDEX `commercial_fraction_holds_status_expires_idx` ON `commercial_fraction_holds`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792182935882;
