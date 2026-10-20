ALTER TABLE `commercial_fraction_holds` MODIFY COLUMN `heldByUserId` int;--> statement-breakpoint
ALTER TABLE `commercial_policy_versions` MODIFY COLUMN `policyType` enum('commission','cancellation','revenue_quality','monetary_adjustment','sale_terms','stock_hold') NOT NULL;--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` ADD `purpose` enum('negotiation','formalization') DEFAULT 'negotiation' NOT NULL;--> statement-breakpoint
ALTER TABLE `commercial_fraction_holds` ADD `contractId` int;--> statement-breakpoint
ALTER TABLE `contracts` ADD `inventoryLostAt` timestamp;