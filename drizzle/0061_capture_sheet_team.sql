CREATE TABLE `capture_sheet_prints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`printedByUserId` int,
	`reprint` boolean NOT NULL DEFAULT false,
	`printedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_sheet_prints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capture_team_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`roleId` int NOT NULL,
	`userId` int,
	`personName` varchar(180),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_team_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_team_members_capture_role_unique` UNIQUE(`captureId`,`roleId`)
);
--> statement-breakpoint
CREATE TABLE `capture_team_roles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`label` varchar(120) NOT NULL,
	`kind` enum('presentation','support') NOT NULL DEFAULT 'presentation',
	`sortOrder` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_team_roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_team_roles_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `coupleCode` varchar(64);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `secondVehicleModel` varchar(120);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `secondVehicleYear` int;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `retiredPrimary` boolean;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `retiredPartner` boolean;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `guest1Name` varchar(180);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `guest2Name` varchar(180);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `pepOffered` boolean;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `pepOfferedBy` varchar(180);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `pepResult` enum('accepted','declined');--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `captures_couple_code_unique` UNIQUE(`coupleCode`);--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD CONSTRAINT `capture_sheet_prints_captureId_capture_records_id_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD CONSTRAINT `capture_sheet_prints_printedByUserId_users_id_fk` FOREIGN KEY (`printedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_team_members` ADD CONSTRAINT `capture_team_members_captureId_capture_records_id_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_team_members` ADD CONSTRAINT `capture_team_members_roleId_capture_team_roles_id_fk` FOREIGN KEY (`roleId`) REFERENCES `capture_team_roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_team_members` ADD CONSTRAINT `capture_team_members_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `capture_sheet_prints_capture_idx` ON `capture_sheet_prints` (`captureId`,`printedAt`);--> statement-breakpoint
CREATE INDEX `capture_team_members_user_idx` ON `capture_team_members` (`userId`);
--> statement-breakpoint
INSERT IGNORE INTO `capture_team_roles` (`code`, `label`, `kind`, `sortOrder`) VALUES
	('promotor_telemarketing', 'Promotor de telemarketing', 'presentation', 10),
	('promotor_marketing', 'Promotor de marketing', 'presentation', 20),
	('lider_marketing', 'Líder de marketing', 'presentation', 30),
	('supervisor_marketing', 'Supervisor de marketing', 'presentation', 40),
	('gerencia_operacional', 'Gerência operacional', 'support', 110),
	('administrativo', 'Administrativo', 'support', 120),
	('recepcao_1', 'Recepção 1', 'support', 130),
	('recepcao_2', 'Recepção 2', 'support', 140);
