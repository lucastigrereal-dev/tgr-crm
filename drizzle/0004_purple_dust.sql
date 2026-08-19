CREATE TABLE `ownership_entitlements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`resortId` int,
	`unitId` int,
	`entitlementType` enum('fixed_week','flexible_week','points','exchange') NOT NULL,
	`fixedWeek` int,
	`annualPoints` int NOT NULL DEFAULT 0,
	`priorityLevel` int NOT NULL DEFAULT 1,
	`validFrom` date,
	`validUntil` date,
	`status` enum('active','suspended','expired','cancelled') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ownership_entitlements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unit_maintenance_blocks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`unitId` int NOT NULL,
	`startsAt` date NOT NULL,
	`endsAt` date NOT NULL,
	`reason` varchar(255) NOT NULL,
	`status` enum('planned','active','completed','cancelled') NOT NULL DEFAULT 'planned',
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `unit_maintenance_blocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ownership_entitlements` ADD CONSTRAINT `ownership_entitlements_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ownership_entitlements` ADD CONSTRAINT `ownership_entitlements_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ownership_entitlements` ADD CONSTRAINT `ownership_entitlements_unitId_units_id_fk` FOREIGN KEY (`unitId`) REFERENCES `units`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unit_maintenance_blocks` ADD CONSTRAINT `unit_maintenance_blocks_unitId_units_id_fk` FOREIGN KEY (`unitId`) REFERENCES `units`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unit_maintenance_blocks` ADD CONSTRAINT `unit_maintenance_blocks_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `entitlements_contract_idx` ON `ownership_entitlements` (`contractId`);--> statement-breakpoint
CREATE INDEX `entitlements_resort_idx` ON `ownership_entitlements` (`resortId`,`status`);--> statement-breakpoint
CREATE INDEX `maintenance_unit_dates_idx` ON `unit_maintenance_blocks` (`unitId`,`startsAt`,`endsAt`);