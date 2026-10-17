ALTER TABLE `capture_sheet_prints` ADD `collectedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD `collectedByUserId` int;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD `destroyedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD `destroyedByUserId` int;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD `destroyDeadlineDays` int;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD CONSTRAINT `capture_sheet_prints_collectedByUserId_users_id_fk` FOREIGN KEY (`collectedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` ADD CONSTRAINT `capture_sheet_prints_destroyedByUserId_users_id_fk` FOREIGN KEY (`destroyedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `capture_sheet_prints_printed_idx` ON `capture_sheet_prints` (`printedAt`,`destroyedAt`);
--> statement-breakpoint
INSERT IGNORE INTO `capture_sheet_settings` (`key`, `value`, `provisional`) VALUES
	('room_visibility_days', '0', true),
	('paper_destroy_deadline_days', '0', true),
	('privacy_controller_name', '', true),
	('privacy_controller_cnpj', '', true),
	('privacy_contact_channel', '', true),
	('privacy_full_text_url', '', true),
	('privacy_retention_text', '', true);
