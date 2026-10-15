CREATE TABLE `owner_portal_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`createdByUserId` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`revokedByUserId` int,
	`lastAccessedAt` timestamp,
	`accessCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `owner_portal_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `owner_portal_token_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `owner_portal_links` ADD CONSTRAINT `owner_portal_links_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `owner_portal_links` ADD CONSTRAINT `owner_portal_links_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `owner_portal_links` ADD CONSTRAINT `owner_portal_links_revokedByUserId_users_id_fk` FOREIGN KEY (`revokedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `owner_portal_customer_idx` ON `owner_portal_links` (`customerId`,`createdAt`);