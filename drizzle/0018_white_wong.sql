CREATE TABLE `contract_cancellation_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`status` enum('requested','approved','rejected','executed','cancelled') NOT NULL DEFAULT 'requested',
	`reason` text NOT NULL,
	`simulationSnapshot` text NOT NULL,
	`requestedByUserId` int NOT NULL,
	`decidedByUserId` int,
	`decisionNotes` text,
	`decidedAt` timestamp,
	`executedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contract_cancellation_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contract_cancellation_requests` ADD CONSTRAINT `contract_cancellation_requests_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_cancellation_requests` ADD CONSTRAINT `contract_cancellation_requests_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_cancellation_requests` ADD CONSTRAINT `contract_cancellation_requests_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `cancellation_requests_contract_status_idx` ON `contract_cancellation_requests` (`contractId`,`status`);--> statement-breakpoint
CREATE INDEX `cancellation_requests_status_idx` ON `contract_cancellation_requests` (`status`,`createdAt`);