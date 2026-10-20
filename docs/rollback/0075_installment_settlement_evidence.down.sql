-- Desfaz 0075 (evidência do recebimento da parcela, CRM-H1). Apaga installments.settlementEvidence (a distinção receipt_claimed / gateway_confirmed / bank_reconciled se perde; a auditoria de conciliação permanece),
-- financial_transactions.installmentId (o vínculo lançamento -> parcela se perde) e o índice. Desligue INSTALLMENT_EVIDENCE_IN_EVENT antes. Roda inteiro em estado parcial e pode ser repetido.
SET @s = (SELECT IF(COUNT(*) > 0, 'DROP INDEX `financial_transactions_installment_idx` ON `financial_transactions`', 'DO 0') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financial_transactions' AND INDEX_NAME = 'financial_transactions_installment_idx');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `financial_transactions` DROP COLUMN `installmentId`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financial_transactions' AND COLUMN_NAME = 'installmentId');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `installments` DROP COLUMN `settlementEvidence`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'installments' AND COLUMN_NAME = 'settlementEvidence');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792532946365;
