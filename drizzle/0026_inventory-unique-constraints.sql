-- Order corrected for clean MySQL 8.4 replay; databases that already recorded 0026 retain the same final schema state.
ALTER TABLE `resorts` ADD CONSTRAINT `resorts_name_unique` UNIQUE(`name`);--> statement-breakpoint
ALTER TABLE `units` ADD CONSTRAINT `units_resort_code_unique` UNIQUE(`resortId`,`code`);--> statement-breakpoint
DROP INDEX `units_resort_code_idx` ON `units`;
