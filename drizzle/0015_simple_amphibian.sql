ALTER TABLE `sales_commissions` ADD `sourceInstallmentId` int;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `commissionRole` enum('liner','closer','ftb') DEFAULT 'ftb' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `lifecycleStatus` varchar(48) DEFAULT 'expected' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `paymentMethod` varchar(64);--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `compensatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `closingAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `cancellationDeadlineAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `expectedPaymentAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `receivedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `cancelledAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_sourceInstallmentId_installments_id_fk` FOREIGN KEY (`sourceInstallmentId`) REFERENCES `installments`(`id`) ON DELETE no action ON UPDATE no action;