CREATE TABLE `reservation_guests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reservationId` int NOT NULL,
	`fullName` varchar(255) NOT NULL,
	`documentNumber` varchar(32),
	`relationship` varchar(80),
	`birthDate` date,
	`checkedInAt` timestamp,
	`checkedOutAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reservation_guests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `reservation_guests` ADD CONSTRAINT `reservation_guests_reservationId_reservations_id_fk` FOREIGN KEY (`reservationId`) REFERENCES `reservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reservation_guests_reservation_idx` ON `reservation_guests` (`reservationId`);--> statement-breakpoint
CREATE INDEX `reservation_guests_document_idx` ON `reservation_guests` (`documentNumber`);