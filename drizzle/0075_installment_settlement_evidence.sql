ALTER TABLE `financial_transactions` ADD `installmentId` int;--> statement-breakpoint
ALTER TABLE `installments` ADD `settlementEvidence` enum('receipt_claimed','gateway_confirmed','bank_reconciled') DEFAULT 'receipt_claimed' NOT NULL;--> statement-breakpoint
CREATE INDEX `financial_transactions_installment_idx` ON `financial_transactions` (`installmentId`);