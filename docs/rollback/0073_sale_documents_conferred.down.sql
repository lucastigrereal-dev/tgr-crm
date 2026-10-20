-- Desfaz 0073 (sale_validations.documentsConferred*, CRM-B1): remove a conferência de documentação.
-- ATENÇÃO: com SALE_ORDER_GATE_ENABLED=true o CRM deixa de exigir a ordem comprovante+documentação antes do contrato; desligue a flag antes de descer. Vendas já validadas não mudam.
-- Cada coluna é conferida no information_schema (o MySQL não aceita DROP COLUMN IF EXISTS): roda inteiro em estado parcial e pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sale_validations` DROP COLUMN `documentsConferredAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_validations' AND COLUMN_NAME = 'documentsConferredAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sale_validations` DROP COLUMN `documentsConferredByUserId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_validations' AND COLUMN_NAME = 'documentsConferredByUserId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `sale_validations` DROP COLUMN `documentsConferredNote`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_validations' AND COLUMN_NAME = 'documentsConferredNote');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792531392056;
