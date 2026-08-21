CREATE TABLE `financial_portfolio_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`assignedByUserId` int,
	`startsAt` timestamp NOT NULL DEFAULT (now()),
	`endsAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_portfolio_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `financial_portfolio_assignments` ADD CONSTRAINT `financial_portfolio_assignments_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_portfolio_assignments` ADD CONSTRAINT `financial_portfolio_assignments_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_portfolio_assignments` ADD CONSTRAINT `financial_portfolio_assignments_assignedByUserId_users_id_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `portfolio_contract_active_idx` ON `financial_portfolio_assignments` (`contractId`,`endsAt`);--> statement-breakpoint
CREATE INDEX `portfolio_owner_active_idx` ON `financial_portfolio_assignments` (`ownerUserId`,`endsAt`);