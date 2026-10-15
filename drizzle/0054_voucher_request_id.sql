ALTER TABLE `vouchers` ADD `requestId` varchar(64);--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_request_unique` UNIQUE(`requestId`);