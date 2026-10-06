CREATE TABLE `policy_registry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`policyType` enum('commission','cancellation_terms','monetary_index','delinquency','retention','messaging','consent_final','contact_hours') NOT NULL,
	`version` varchar(80) NOT NULL,
	`status` enum('DRAFT','UNAPPROVED','APPROVED','RETIRED') NOT NULL DEFAULT 'UNAPPROVED',
	`validFrom` date,
	`validTo` date,
	`approver` varchar(160),
	`receiptRef` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `policy_registry_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_registry_version_unique` UNIQUE(`resortId`,`policyType`,`version`)
);
--> statement-breakpoint
ALTER TABLE `policy_registry` ADD CONSTRAINT `policy_registry_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `policy_registry_status_idx` ON `policy_registry` (`resortId`,`status`);