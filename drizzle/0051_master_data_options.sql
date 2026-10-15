CREATE TABLE `master_data_options` (
	`id` int AUTO_INCREMENT NOT NULL,
	`field` enum('captureLocation','transportation','vehicleBrand','partnerProfession') NOT NULL,
	`value` varchar(180) NOT NULL,
	`normalizedKey` varchar(180) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `master_data_options_id` PRIMARY KEY(`id`),
	CONSTRAINT `master_data_options_field_key_unique` UNIQUE(`field`,`normalizedKey`)
);
--> statement-breakpoint
ALTER TABLE `master_data_options` ADD CONSTRAINT `master_data_options_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;