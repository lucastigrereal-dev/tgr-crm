-- Desfaz 0069 (sales_commissions.ruleVersion, CRM-A13): remove a coluna que fixa a versão da regra por contrato.
-- ATENÇÃO: depois disso o CRM deixa de saber quais comissões vieram do motor V2; só desça com COMMISSION_V2_RELEASED=false e sem linhas 'v2'.
-- Confere a coluna no information_schema (o MySQL não aceita DROP COLUMN IF EXISTS): roda inteiro em estado parcial e pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sales_commissions` DROP COLUMN `ruleVersion`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_commissions' AND COLUMN_NAME = 'ruleVersion');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792451460597;
