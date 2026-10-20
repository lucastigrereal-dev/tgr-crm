CREATE TABLE `financial_project_map` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`externalKey` varchar(64) NOT NULL,
	`name` varchar(160) NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'America/Recife',
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_project_map_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_project_map_resort_unique` UNIQUE(`resortId`)
);
--> statement-breakpoint
ALTER TABLE `financial_project_map` ADD CONSTRAINT `financial_project_map_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;