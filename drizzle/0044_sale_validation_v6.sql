CREATE TABLE `sale_validation_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`step` enum('payment_confirmed','final_validated','validation_rejected') NOT NULL,
	`actorUserId` int NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`beforeJson` text,
	`afterJson` text,
	`reason` text,
	`documentRef` varchar(512),
	`correlationId` varchar(120) NOT NULL,
	CONSTRAINT `sale_validation_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sale_validations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`paymentConfirmedAt` timestamp,
	`paymentConfirmedByUserId` int,
	`paymentConfirmationNote` text,
	`paymentEvidenceRef` varchar(512),
	`validatedAt` timestamp,
	`validatedByUserId` int,
	`signedDocumentId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sale_validations_id` PRIMARY KEY(`id`),
	CONSTRAINT `sale_validations_contract_unique` UNIQUE(`contractId`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcome` enum('vendeu','caiu_em_mesa');--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcomeReason` text;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcomeAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcomeByUserId` int;--> statement-breakpoint
ALTER TABLE `sale_validation_events` ADD CONSTRAINT `sve_contract_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validation_events` ADD CONSTRAINT `sve_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD CONSTRAINT `sv_contract_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD CONSTRAINT `sv_payment_user_fk` FOREIGN KEY (`paymentConfirmedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD CONSTRAINT `sv_validated_user_fk` FOREIGN KEY (`validatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD CONSTRAINT `sv_signed_document_fk` FOREIGN KEY (`signedDocumentId`) REFERENCES `contract_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sve_contract_idx` ON `sale_validation_events` (`contractId`,`occurredAt`);--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_commercialOutcomeByUserId_users_id_fk` FOREIGN KEY (`commercialOutcomeByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER `sale_validation_events_no_update` BEFORE UPDATE ON `sale_validation_events` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_validation_events is append-only';
--> statement-breakpoint
CREATE TRIGGER `sale_validation_events_no_delete` BEFORE DELETE ON `sale_validation_events` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_validation_events is append-only';
