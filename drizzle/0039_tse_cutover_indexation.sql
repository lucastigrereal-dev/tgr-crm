ALTER TABLE `commercial_policy_versions` MODIFY COLUMN `policyType` enum('commission','cancellation','revenue_quality','monetary_adjustment') NOT NULL;
--> statement-breakpoint
CREATE TABLE `monetary_index_values` (
  `id` int AUTO_INCREMENT NOT NULL,
  `indexCode` varchar(40) NOT NULL,
  `referenceDate` date NOT NULL,
  `variationPercent` decimal(9,6) NOT NULL,
  `source` varchar(255) NOT NULL,
  `sourceReference` varchar(500),
  `importedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `monetary_index_values_id` PRIMARY KEY(`id`),
  CONSTRAINT `monetary_index_values_code_date_unique` UNIQUE(`indexCode`,`referenceDate`)
);
--> statement-breakpoint
CREATE INDEX `monetary_index_values_code_date_idx` ON `monetary_index_values` (`indexCode`,`referenceDate`);
--> statement-breakpoint
ALTER TABLE `monetary_index_values` ADD CONSTRAINT `monetary_index_values_importedByUserId_users_id_fk` FOREIGN KEY (`importedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `contract_monetary_adjustments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contractId` int NOT NULL,
  `policyVersionId` int NOT NULL,
  `indexCode` varchar(40) NOT NULL,
  `baseDate` date NOT NULL,
  `throughDate` date NOT NULL,
  `periodicityMonths` int NOT NULL,
  `spreadMonthlyPercent` decimal(7,4) NOT NULL DEFAULT '0.0000',
  `indexFactor` decimal(18,10) NOT NULL,
  `spreadFactor` decimal(18,10) NOT NULL,
  `totalFactor` decimal(18,10) NOT NULL,
  `beforeTotal` decimal(14,2) NOT NULL,
  `afterTotal` decimal(14,2) NOT NULL,
  `calculationJson` text NOT NULL,
  `appliedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `contract_monetary_adjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `contract_adjustment_contract_through_unique` UNIQUE(`contractId`,`throughDate`)
);
--> statement-breakpoint
CREATE INDEX `contract_adjustment_contract_created_idx` ON `contract_monetary_adjustments` (`contractId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `contract_adjustment_policy_idx` ON `contract_monetary_adjustments` (`policyVersionId`,`createdAt`);
--> statement-breakpoint
ALTER TABLE `contract_monetary_adjustments` ADD CONSTRAINT `contract_monetary_adjustments_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `contract_monetary_adjustments` ADD CONSTRAINT `contract_monetary_adjustments_policyVersionId_commercial_policy_versions_id_fk` FOREIGN KEY (`policyVersionId`) REFERENCES `commercial_policy_versions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `contract_monetary_adjustments` ADD CONSTRAINT `contract_monetary_adjustments_appliedByUserId_users_id_fk` FOREIGN KEY (`appliedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
