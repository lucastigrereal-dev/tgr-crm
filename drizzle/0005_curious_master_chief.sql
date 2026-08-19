CREATE TABLE `reservation_waitlist` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`contractId` int,
	`resortId` int,
	`desiredCheckIn` date NOT NULL,
	`desiredCheckOut` date NOT NULL,
	`partySize` int NOT NULL DEFAULT 1,
	`priorityScore` int NOT NULL DEFAULT 0,
	`preferenceNotes` text,
	`status` enum('waiting','offered','confirmed','expired','cancelled') NOT NULL DEFAULT 'waiting',
	`offeredAt` timestamp,
	`expiresAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reservation_waitlist_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `reservation_waitlist` ADD CONSTRAINT `reservation_waitlist_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservation_waitlist` ADD CONSTRAINT `reservation_waitlist_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservation_waitlist` ADD CONSTRAINT `reservation_waitlist_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservation_waitlist` ADD CONSTRAINT `reservation_waitlist_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `waitlist_resort_window_idx` ON `reservation_waitlist` (`resortId`,`desiredCheckIn`,`desiredCheckOut`,`status`);--> statement-breakpoint
CREATE INDEX `waitlist_customer_idx` ON `reservation_waitlist` (`customerId`,`status`);