ALTER TABLE `resorts` ADD `externalKey` varchar(120);
--> statement-breakpoint
CREATE UNIQUE INDEX `resorts_external_key_unique` ON `resorts` (`externalKey`);
--> statement-breakpoint
ALTER TABLE `commercial_policy_versions` MODIFY COLUMN `policyType` enum('commission','cancellation','revenue_quality','monetary_adjustment','sale_terms') NOT NULL;
--> statement-breakpoint
ALTER TABLE `contracts` ADD `externalSource` varchar(64);
--> statement-breakpoint
ALTER TABLE `contracts` ADD `externalSaleId` varchar(120);
--> statement-breakpoint
CREATE UNIQUE INDEX `contracts_external_sale_unique` ON `contracts` (`externalSource`,`externalSaleId`);
--> statement-breakpoint
ALTER TABLE `installments` ADD `paidAmount` decimal(14,2) NOT NULL DEFAULT '0.00';
