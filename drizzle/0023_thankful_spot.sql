CREATE TABLE `saved_analysis_views` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`scope` enum('dashboard') NOT NULL DEFAULT 'dashboard',
	`visibility` enum('personal','shared') NOT NULL DEFAULT 'personal',
	`filtersJson` text NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `saved_analysis_views_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `saved_analysis_views` ADD CONSTRAINT `saved_analysis_views_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `saved_views_creator_idx` ON `saved_analysis_views` (`createdByUserId`,`scope`);--> statement-breakpoint
CREATE INDEX `saved_views_visibility_idx` ON `saved_analysis_views` (`visibility`,`scope`);