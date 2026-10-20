-- Desfaz 0076 (versionamento da política de comissão, CRM-F1). Apaga SÓ as versões semeadas pela migração (seededBy = 'migration-0076-legacy'); uma `legacy-1` criada por pessoa
-- permanece. Apaga também as colunas seededBy e sales_commissions.policyVersion (a rastreabilidade da versão por comissão se perde). Desligue COMMISSION_POLICY_VERSIONING_ENABLED antes. Pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'DELETE FROM `commercial_policy_versions` WHERE `seededBy` = ''migration-0076-legacy''', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commercial_policy_versions' AND COLUMN_NAME = 'seededBy');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `commercial_policy_versions` DROP COLUMN `seededBy`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commercial_policy_versions' AND COLUMN_NAME = 'seededBy');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sales_commissions` DROP COLUMN `policyVersion`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_commissions' AND COLUMN_NAME = 'policyVersion');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792534201492;
