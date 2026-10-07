ALTER TABLE `sale_validation_events` ADD `externalSaleId` varchar(120);--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `contractGeneratedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `contractSignedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `documentStoredAt` timestamp;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `documentRef` varchar(200);