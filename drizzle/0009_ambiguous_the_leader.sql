ALTER TABLE `financial_transactions` ADD `campaignId` int;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD `reconciliationReference` varchar(255);--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD `reconciledAt` timestamp;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD `reconciledByUserId` int;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD CONSTRAINT `financial_transactions_campaignId_sales_campaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `sales_campaigns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD CONSTRAINT `financial_transactions_reconciledByUserId_users_id_fk` FOREIGN KEY (`reconciledByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `financial_transactions_campaign_idx` ON `financial_transactions` (`campaignId`,`status`);