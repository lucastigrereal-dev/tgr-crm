-- Desfaz 0076 (versionamento da política de comissão, CRM-F1). Apaga as versões `legacy-1` criadas pela migração (o legado em commercial_project_settings segue intacto)
-- e a coluna sales_commissions.policyVersion (a rastreabilidade da versão por comissão se perde). Desligue COMMISSION_POLICY_VERSIONING_ENABLED antes. Pode ser repetido.
DELETE FROM `commercial_policy_versions` WHERE `policyType` = 'commission' AND `version` = 'legacy-1';
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sales_commissions` DROP COLUMN `policyVersion`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_commissions' AND COLUMN_NAME = 'policyVersion');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792533364144;
