CREATE TABLE `qualification_policy_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`version` varchar(80) NOT NULL,
	`paramsJson` text NOT NULL,
	`effectiveAt` timestamp NOT NULL DEFAULT (now()),
	`retiredAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `qualification_policy_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `qualification_policy_version_unique` UNIQUE(`version`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `nqPolicyVersion` varchar(80);--> statement-breakpoint
ALTER TABLE `qualification_policy_versions` ADD CONSTRAINT `qualification_policy_versions_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `qualification_policy_effective_idx` ON `qualification_policy_versions` (`effectiveAt`);