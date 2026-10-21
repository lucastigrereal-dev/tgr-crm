-- Desfaz 0077 (versionamento da política de qualificação, CRM-G1). Apaga a tabela qualification_policy_versions e a coluna capture_records.nqPolicyVersion
-- (a rastreabilidade da versão por ficha se perde). Desligue QUALIFICATION_POLICY_VERSIONING_ENABLED antes: o NQ volta a usar só capture_sheet_settings. Pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `nqPolicyVersion`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'nqPolicyVersion');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DROP TABLE IF EXISTS `qualification_policy_versions`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792539734242;
