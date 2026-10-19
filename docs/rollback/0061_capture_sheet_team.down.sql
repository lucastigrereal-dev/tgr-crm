-- Rollback da migração 0061 (TSE x CRM: ficha com código do casal, equipe por papel, campos novos).
-- Perde o que foi gravado nas tabelas e colunas novas; as fichas e o resto do CRM não mudam.
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
-- A última linha tira a 0061 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
-- Ordem: desfaça 0066, 0065, 0064, 0063 e 0062 antes (a 0063 tem chaves estrangeiras em capture_sheet_prints).
DROP TABLE IF EXISTS `capture_sheet_prints`;
--> statement-breakpoint
DROP TABLE IF EXISTS `capture_team_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `capture_team_roles`;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'DROP INDEX `captures_couple_code_unique` ON `capture_records`', 'DO 0') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND INDEX_NAME = 'captures_couple_code_unique');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `coupleCode`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'coupleCode');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `secondVehicleModel`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'secondVehicleModel');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `secondVehicleYear`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'secondVehicleYear');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `retiredPrimary`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'retiredPrimary');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `retiredPartner`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'retiredPartner');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `guest1Name`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'guest1Name');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `guest2Name`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'guest2Name');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `pepOffered`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'pepOffered');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `pepOfferedBy`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'pepOfferedBy');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `pepResult`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'pepResult');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792245940048;
