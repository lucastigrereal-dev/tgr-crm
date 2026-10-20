CREATE TABLE `contract_addenda` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`kind` enum('clause','contact') NOT NULL,
	`status` enum('draft','awaiting_signature','signed','cancelled') NOT NULL DEFAULT 'draft',
	`reason` text NOT NULL,
	`payload` text NOT NULL,
	`requestedByUserId` int NOT NULL,
	`signedDocumentId` int,
	`decidedByUserId` int,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contract_addenda_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contract_addenda` ADD CONSTRAINT `contract_addenda_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_addenda` ADD CONSTRAINT `contract_addenda_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_addenda` ADD CONSTRAINT `contract_addenda_signedDocumentId_contract_documents_id_fk` FOREIGN KEY (`signedDocumentId`) REFERENCES `contract_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_addenda` ADD CONSTRAINT `contract_addenda_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `contract_addenda_contract_idx` ON `contract_addenda` (`contractId`,`status`);