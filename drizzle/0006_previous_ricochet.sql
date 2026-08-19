CREATE TABLE `installment_renegotiations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`originalInstallmentId` int NOT NULL,
	`originalAmount` decimal(14,2) NOT NULL,
	`proposedAmount` decimal(14,2) NOT NULL,
	`proposedDueDate` date NOT NULL,
	`discountAmount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`notes` text,
	`status` enum('draft','approved','applied','rejected','cancelled') NOT NULL DEFAULT 'draft',
	`createdByUserId` int,
	`approvedByUserId` int,
	`appliedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `installment_renegotiations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `installment_renegotiations` ADD CONSTRAINT `installment_renegotiations_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `installment_renegotiations` ADD CONSTRAINT `reneg_orig_installment_fk` FOREIGN KEY (`originalInstallmentId`) REFERENCES `installments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `installment_renegotiations` ADD CONSTRAINT `reneg_created_user_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `installment_renegotiations` ADD CONSTRAINT `reneg_approved_user_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `renegotiations_contract_idx` ON `installment_renegotiations` (`contractId`,`status`);--> statement-breakpoint
CREATE INDEX `renegotiations_installment_idx` ON `installment_renegotiations` (`originalInstallmentId`,`status`);
