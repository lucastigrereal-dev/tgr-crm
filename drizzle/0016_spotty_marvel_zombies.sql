CREATE TABLE `commercial_project_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`cancellationPolicy` text,
	`requiredCaptureFields` text,
	`commercialRoles` text,
	`commissionPolicy` text,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `commercial_project_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `commercial_project_settings_resortId_unique` UNIQUE(`resortId`)
);
--> statement-breakpoint
ALTER TABLE `commercial_project_settings` ADD CONSTRAINT `commercial_project_settings_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commercial_project_settings` ADD CONSTRAINT `commercial_project_settings_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;