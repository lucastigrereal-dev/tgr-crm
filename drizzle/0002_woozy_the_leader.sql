CREATE TABLE `csv_import_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` enum('customers','contracts') NOT NULL,
	`status` enum('completed','reverted') NOT NULL DEFAULT 'completed',
	`actorUserId` int NOT NULL,
	`totalRows` int NOT NULL DEFAULT 0,
	`createdCount` int NOT NULL DEFAULT 0,
	`updatedCount` int NOT NULL DEFAULT 0,
	`rejectedCount` int NOT NULL DEFAULT 0,
	`revertedAt` timestamp,
	`revertedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `csv_import_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `csv_import_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batchId` int NOT NULL,
	`entityType` enum('customer','contract') NOT NULL,
	`entityId` int NOT NULL,
	`action` enum('created','updated') NOT NULL,
	`beforeSnapshot` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `csv_import_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales_campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`code` varchar(64) NOT NULL,
	`description` text,
	`startsAt` date,
	`endsAt` date,
	`commissionRate` decimal(5,2) NOT NULL DEFAULT '0.00',
	`status` enum('draft','active','closed') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_campaigns_id` PRIMARY KEY(`id`),
	CONSTRAINT `sales_campaigns_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `sales_commissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sellerId` int NOT NULL,
	`campaignId` int,
	`opportunityId` int,
	`contractId` int,
	`baseAmount` decimal(14,2) NOT NULL,
	`rate` decimal(5,2) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`status` enum('pending','approved','paid','cancelled') NOT NULL DEFAULT 'pending',
	`notes` text,
	`approvedAt` timestamp,
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_commissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `opportunities` ADD `campaignId` int;--> statement-breakpoint
ALTER TABLE `csv_import_batches` ADD CONSTRAINT `csv_import_batches_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `csv_import_batches` ADD CONSTRAINT `csv_import_batches_revertedByUserId_users_id_fk` FOREIGN KEY (`revertedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `csv_import_items` ADD CONSTRAINT `csv_import_items_batchId_csv_import_batches_id_fk` FOREIGN KEY (`batchId`) REFERENCES `csv_import_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_sellerId_users_id_fk` FOREIGN KEY (`sellerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_campaignId_sales_campaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `sales_campaigns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_opportunityId_opportunities_id_fk` FOREIGN KEY (`opportunityId`) REFERENCES `opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `csv_batches_recent_idx` ON `csv_import_batches` (`createdAt`,`status`);--> statement-breakpoint
CREATE INDEX `csv_items_batch_idx` ON `csv_import_items` (`batchId`);--> statement-breakpoint
CREATE INDEX `commissions_seller_idx` ON `sales_commissions` (`sellerId`,`status`);--> statement-breakpoint
CREATE INDEX `commissions_campaign_idx` ON `sales_commissions` (`campaignId`);--> statement-breakpoint
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_campaignId_sales_campaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `sales_campaigns`(`id`) ON DELETE no action ON UPDATE no action;