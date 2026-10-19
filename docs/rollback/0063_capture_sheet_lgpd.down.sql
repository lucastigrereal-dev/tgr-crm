-- Rollback da migração 0063 (LGPD da ficha: custódia do papel recolhido/destruído e textos do aviso de privacidade).
-- Perde o registro de recolhimento/destruição gravado nas colunas novas; as impressões, as fichas e o resto do CRM não mudam.
-- Só apaga as 7 chaves que ainda são as sementes da migration (provisórias e nunca editadas: updatedByUserId nulo); valor que a administração já definiu fica.
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
-- A última linha tira a 0063 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
SET @s = (SELECT IF(COUNT(*) > 0, 'DROP INDEX `capture_sheet_prints_printed_idx` ON `capture_sheet_prints`', 'DO 0') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND INDEX_NAME = 'capture_sheet_prints_printed_idx');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP FOREIGN KEY `capture_sheet_prints_collectedByUserId_users_id_fk`', 'DO 0') FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND CONSTRAINT_NAME = 'capture_sheet_prints_collectedByUserId_users_id_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP FOREIGN KEY `capture_sheet_prints_destroyedByUserId_users_id_fk`', 'DO 0') FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND CONSTRAINT_NAME = 'capture_sheet_prints_destroyedByUserId_users_id_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP COLUMN `collectedAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND COLUMN_NAME = 'collectedAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP COLUMN `collectedByUserId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND COLUMN_NAME = 'collectedByUserId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP COLUMN `destroyedAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND COLUMN_NAME = 'destroyedAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP COLUMN `destroyedByUserId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND COLUMN_NAME = 'destroyedByUserId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_sheet_prints` DROP COLUMN `destroyDeadlineDays`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_prints' AND COLUMN_NAME = 'destroyDeadlineDays');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- A tabela de limites só existe se a 0062 ainda está aplicada; sem ela não há semente para apagar.
SET @s = (SELECT IF(COUNT(*) > 0, 'DELETE FROM `capture_sheet_settings` WHERE `provisional` = true AND `updatedByUserId` IS NULL AND `key` IN (''room_visibility_days'',''paper_destroy_deadline_days'',''privacy_controller_name'',''privacy_controller_cnpj'',''privacy_contact_channel'',''privacy_full_text_url'',''privacy_retention_text'')', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_settings');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792254082875;
