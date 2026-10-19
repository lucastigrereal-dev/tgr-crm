-- Desfaz 0064: só remove o que a 0064 criou. Rode apenas se nenhuma ficha usa os motivos (ntMotiveId / commercialOutcomeMotiveId).
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntRecordedByUserId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntRecordedByUserId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntRecordedAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntRecordedAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntCaptorName`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntCaptorName');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntComplement`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntComplement');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntMotiveId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntMotiveId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `ntKind`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'ntKind');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `commercialOutcomeComplement`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'commercialOutcomeComplement');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `commercialOutcomeMotiveId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'commercialOutcomeMotiveId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DROP TABLE IF EXISTS `capture_motives`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792261967301;
