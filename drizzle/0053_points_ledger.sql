CREATE TABLE `points_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`entitlementId` int NOT NULL,
	`entryType` enum('annual_credit','usage','adjustment','reversal') NOT NULL,
	`points` int NOT NULL,
	`referenceYear` int,
	`reservationId` int,
	`reversesEntryId` int,
	`note` varchar(255),
	`idempotencyKey` varchar(80),
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `points_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `points_ledger_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `points_ledger` ADD CONSTRAINT `points_ledger_entitlementId_ownership_entitlements_id_fk` FOREIGN KEY (`entitlementId`) REFERENCES `ownership_entitlements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `points_ledger` ADD CONSTRAINT `points_ledger_reservationId_reservations_id_fk` FOREIGN KEY (`reservationId`) REFERENCES `reservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `points_ledger` ADD CONSTRAINT `points_ledger_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `points_ledger_entitlement_idx` ON `points_ledger` (`entitlementId`,`id`);