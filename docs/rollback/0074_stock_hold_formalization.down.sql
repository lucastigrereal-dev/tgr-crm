-- Desfaz 0074 (hold de formalização, CRM-E1).
-- ANTES de descer: desligue INVENTORY_HOLD_AT_FORMALIZATION e deixe o sweep/administração liberar os holds 'formalization' ativos (cotas 'held' de contrato em formalização
-- voltam a 'available'); contratos com inventoryLostAt perdem a marca (a trilha em audit_logs/tasks permanece). Políticas 'stock_hold' são APAGADAS (exporte antes se precisar).
-- Roda inteiro em estado parcial e pode ser repetido.
DELETE FROM `commercial_policy_versions` WHERE `policyType` = 'stock_hold';
--> statement-breakpoint
ALTER TABLE `commercial_policy_versions` MODIFY COLUMN `policyType` enum('commission','cancellation','revenue_quality','monetary_adjustment','sale_terms') NOT NULL;
--> statement-breakpoint
UPDATE `commercial_fraction_holds` SET `heldByUserId` = (SELECT `id` FROM `users` ORDER BY `id` LIMIT 1) WHERE `heldByUserId` IS NULL;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` MODIFY COLUMN `heldByUserId` int NOT NULL;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `commercial_fraction_holds` DROP COLUMN `purpose`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commercial_fraction_holds' AND COLUMN_NAME = 'purpose');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `commercial_fraction_holds` DROP COLUMN `contractId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commercial_fraction_holds' AND COLUMN_NAME = 'contractId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `contracts` DROP COLUMN `inventoryLostAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'inventoryLostAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792532279202;
