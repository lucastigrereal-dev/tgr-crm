-- Rollback da migração 0062 (ficha impressa: campos do casal qualificado, tipo de veículo, limites configuráveis).
-- Perde o que foi gravado nas colunas e na tabela novas; as fichas e o resto do CRM não mudam.
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
-- A última linha tira a 0062 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
-- O papel `supervisor_vendas` fica: pode ter sido criado pela administração antes da 0062 e já ter vínculos; sozinho ele não faz mal.
DROP TABLE IF EXISTS `capture_sheet_settings`;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `maleSpouse`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'maleSpouse');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `vehicleKind`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'vehicleKind');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `secondVehicleKind`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'secondVehicleKind');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `watchedVacationPresentation`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'watchedVacationPresentation');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `captureKind`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'captureKind');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792252638771;
