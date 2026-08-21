CREATE TABLE `commercial_policy_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`policyType` enum('commission','cancellation','revenue_quality') NOT NULL,
	`version` varchar(80) NOT NULL,
	`policyJson` text NOT NULL,
	`effectiveAt` timestamp NOT NULL DEFAULT (now()),
	`retiredAt` timestamp,
	`approvedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `commercial_policy_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `commercial_policy_version_unique` UNIQUE(`resortId`,`policyType`,`version`)
);
--> statement-breakpoint
CREATE TABLE `revenue_quality_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`installmentId` int,
	`commissionId` int,
	`domainEventId` int,
	`policyVersionId` int,
	`factType` enum('vgv_formalized','cash_confirmed','cash_exposure','revenue_reversed','cancellation_retention','cancellation_refund','commission_expected','commission_at_risk','commission_paid','commission_reversed') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`reason` varchar(80),
	`sourceFingerprint` varchar(160) NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `revenue_quality_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `revenue_ledger_fingerprint_unique` UNIQUE(`sourceFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `commercial_policy_versions` ADD CONSTRAINT `commercial_policy_versions_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commercial_policy_versions` ADD CONSTRAINT `commercial_policy_versions_approvedByUserId_users_id_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `revenue_quality_ledger` ADD CONSTRAINT `revenue_quality_ledger_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `revenue_quality_ledger` ADD CONSTRAINT `revenue_quality_ledger_installmentId_installments_id_fk` FOREIGN KEY (`installmentId`) REFERENCES `installments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `revenue_quality_ledger` ADD CONSTRAINT `revenue_quality_ledger_commissionId_sales_commissions_id_fk` FOREIGN KEY (`commissionId`) REFERENCES `sales_commissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `revenue_quality_ledger` ADD CONSTRAINT `revenue_quality_ledger_domainEventId_domain_events_id_fk` FOREIGN KEY (`domainEventId`) REFERENCES `domain_events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `revenue_quality_ledger` ADD CONSTRAINT `revenue_ledger_policy_fk` FOREIGN KEY (`policyVersionId`) REFERENCES `commercial_policy_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `commercial_policy_effective_idx` ON `commercial_policy_versions` (`resortId`,`policyType`,`effectiveAt`);--> statement-breakpoint
CREATE INDEX `revenue_ledger_contract_fact_idx` ON `revenue_quality_ledger` (`contractId`,`factType`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `revenue_ledger_policy_idx` ON `revenue_quality_ledger` (`policyVersionId`,`occurredAt`);
