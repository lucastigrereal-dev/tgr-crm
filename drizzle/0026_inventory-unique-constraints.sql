ALTER TABLE `resorts` ADD CONSTRAINT `resorts_name_unique` UNIQUE(`name`);--> statement-breakpoint
ALTER TABLE `units` ADD CONSTRAINT `units_resort_code_unique` UNIQUE(`resortId`,`code`);--> statement-breakpoint
DROP INDEX `units_resort_code_idx` ON `units`;
