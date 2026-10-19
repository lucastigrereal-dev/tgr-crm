CREATE TABLE `capture_erasure_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`customerId` int NOT NULL,
	`coupleCode` varchar(64) NOT NULL,
	`status` enum('requested','completed','rejected') NOT NULL DEFAULT 'requested',
	`reason` varchar(500) NOT NULL,
	`requestedByUserId` int,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`decidedByUserId` int,
	`decidedAt` timestamp,
	`decisionNote` varchar(500),
	`giftDate` timestamp,
	`sheetsAnonymized` int,
	CONSTRAINT `capture_erasure_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `anonymizedAt` timestamp;--> statement-breakpoint
ALTER TABLE `customers` ADD `anonymizedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_erasure_requests` ADD CONSTRAINT `capture_erasure_requests_captureId_capture_records_id_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_erasure_requests` ADD CONSTRAINT `capture_erasure_requests_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_erasure_requests` ADD CONSTRAINT `capture_erasure_requests_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_erasure_requests` ADD CONSTRAINT `capture_erasure_requests_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `capture_erasure_requests_capture_idx` ON `capture_erasure_requests` (`captureId`,`status`);--> statement-breakpoint
CREATE INDEX `capture_erasure_requests_customer_idx` ON `capture_erasure_requests` (`customerId`);--> statement-breakpoint
INSERT IGNORE INTO `capture_sheet_settings` (`key`, `value`, `provisional`) VALUES
	('privacy_dpo_name', '', true);
