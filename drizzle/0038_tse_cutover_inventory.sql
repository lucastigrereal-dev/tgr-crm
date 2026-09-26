CREATE TABLE `commercial_fractions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `resortId` int NOT NULL,
  `unitId` int NOT NULL,
  `code` varchar(96) NOT NULL,
  `sequence` int NOT NULL,
  `status` enum('available','held','sold','blocked') NOT NULL DEFAULT 'available',
  `currentProposalId` int,
  `currentContractId` int,
  `listPrice` decimal(14,2),
  `priceTableVersion` varchar(80),
  `heldUntil` timestamp NULL,
  `blockedReason` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commercial_fractions_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercial_fractions_resort_code_unique` UNIQUE(`resortId`,`code`),
  CONSTRAINT `commercial_fractions_unit_sequence_unique` UNIQUE(`unitId`,`sequence`)
);
--> statement-breakpoint
CREATE INDEX `commercial_fractions_resort_status_idx` ON `commercial_fractions` (`resortId`,`status`);
--> statement-breakpoint
CREATE INDEX `commercial_fractions_proposal_status_idx` ON `commercial_fractions` (`currentProposalId`,`status`);
--> statement-breakpoint
CREATE INDEX `commercial_fractions_contract_status_idx` ON `commercial_fractions` (`currentContractId`,`status`);
--> statement-breakpoint
ALTER TABLE `commercial_fractions` ADD CONSTRAINT `commercial_fractions_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fractions` ADD CONSTRAINT `commercial_fractions_unitId_units_id_fk` FOREIGN KEY (`unitId`) REFERENCES `units`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fractions` ADD CONSTRAINT `commercial_fractions_currentProposalId_proposals_id_fk` FOREIGN KEY (`currentProposalId`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fractions` ADD CONSTRAINT `commercial_fractions_currentContractId_contracts_id_fk` FOREIGN KEY (`currentContractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `commercial_fraction_holds` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fractionId` int NOT NULL,
  `proposalId` int,
  `heldByUserId` int NOT NULL,
  `activeKey` varchar(128),
  `status` enum('active','released','expired','consumed') NOT NULL DEFAULT 'active',
  `expiresAt` timestamp NOT NULL,
  `releasedAt` timestamp NULL,
  `releaseReason` varchar(255),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commercial_fraction_holds_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercial_fraction_holds_active_key_unique` UNIQUE(`activeKey`)
);
--> statement-breakpoint
CREATE INDEX `commercial_fraction_holds_fraction_status_idx` ON `commercial_fraction_holds` (`fractionId`,`status`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `commercial_fraction_holds_proposal_status_idx` ON `commercial_fraction_holds` (`proposalId`,`status`);
--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` ADD CONSTRAINT `commercial_fraction_holds_fractionId_commercial_fractions_id_fk` FOREIGN KEY (`fractionId`) REFERENCES `commercial_fractions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` ADD CONSTRAINT `commercial_fraction_holds_proposalId_proposals_id_fk` FOREIGN KEY (`proposalId`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` ADD CONSTRAINT `commercial_fraction_holds_heldByUserId_users_id_fk` FOREIGN KEY (`heldByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `commercial_fraction_history` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fractionId` int NOT NULL,
  `fromStatus` varchar(32),
  `toStatus` varchar(32) NOT NULL,
  `proposalId` int,
  `contractId` int,
  `actorUserId` int,
  `reason` varchar(255) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercial_fraction_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `commercial_fraction_history_fraction_idx` ON `commercial_fraction_history` (`fractionId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `commercial_fraction_history_contract_idx` ON `commercial_fraction_history` (`contractId`,`createdAt`);
--> statement-breakpoint
ALTER TABLE `commercial_fraction_history` ADD CONSTRAINT `commercial_fraction_history_fractionId_commercial_fractions_id_fk` FOREIGN KEY (`fractionId`) REFERENCES `commercial_fractions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_history` ADD CONSTRAINT `commercial_fraction_history_proposalId_proposals_id_fk` FOREIGN KEY (`proposalId`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_history` ADD CONSTRAINT `commercial_fraction_history_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `commercial_fraction_history` ADD CONSTRAINT `commercial_fraction_history_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
