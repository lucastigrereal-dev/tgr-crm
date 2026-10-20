CREATE TABLE `sale_validator_grants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`grantedByUserId` int NOT NULL,
	`validFrom` timestamp NOT NULL DEFAULT (now()),
	`validUntil` timestamp,
	`note` text,
	`revokedAt` timestamp,
	`revokedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sale_validator_grants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sale_validator_grants` ADD CONSTRAINT `sale_validator_grants_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validator_grants` ADD CONSTRAINT `sale_validator_grants_grantedByUserId_users_id_fk` FOREIGN KEY (`grantedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_validator_grants` ADD CONSTRAINT `sale_validator_grants_revokedByUserId_users_id_fk` FOREIGN KEY (`revokedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sale_validator_grants_user_idx` ON `sale_validator_grants` (`userId`,`revokedAt`);