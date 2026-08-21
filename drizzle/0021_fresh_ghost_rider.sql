ALTER TABLE `capture_records` ADD `qualifierId` int;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `roomManagerId` int;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_qualifierId_users_id_fk` FOREIGN KEY (`qualifierId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_roomManagerId_users_id_fk` FOREIGN KEY (`roomManagerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `captures_qualifier_status_idx` ON `capture_records` (`qualifierId`,`presentationStatus`,`createdAt`);--> statement-breakpoint
CREATE INDEX `captures_room_manager_status_idx` ON `capture_records` (`roomManagerId`,`presentationStatus`,`createdAt`);