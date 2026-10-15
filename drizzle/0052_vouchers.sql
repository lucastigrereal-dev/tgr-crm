CREATE TABLE `vouchers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(16) NOT NULL,
	`customerId` int NOT NULL,
	`captureId` int,
	`description` varchar(255) NOT NULL,
	`costAmount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`expiresAt` date,
	`status` enum('issued','redeemed','cancelled') NOT NULL DEFAULT 'issued',
	`issuedByUserId` int,
	`issuedAt` timestamp NOT NULL DEFAULT (now()),
	`redeemedAt` timestamp,
	`redeemedByUserId` int,
	`redeemNote` varchar(255),
	`cancelledAt` timestamp,
	`cancelledByUserId` int,
	`cancelReason` varchar(255),
	CONSTRAINT `vouchers_id` PRIMARY KEY(`id`),
	CONSTRAINT `vouchers_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_captureId_capture_records_id_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_issuedByUserId_users_id_fk` FOREIGN KEY (`issuedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_redeemedByUserId_users_id_fk` FOREIGN KEY (`redeemedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_cancelledByUserId_users_id_fk` FOREIGN KEY (`cancelledByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vouchers_customer_idx` ON `vouchers` (`customerId`);--> statement-breakpoint
CREATE INDEX `vouchers_status_expiry_idx` ON `vouchers` (`status`,`expiresAt`);