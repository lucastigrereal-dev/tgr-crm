ALTER TABLE `capture_records` ADD `salesTable` varchar(64);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `assignedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `presentationStartedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `presentationEndedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `receptionNotes` text;--> statement-breakpoint
CREATE INDEX `captures_room_status_idx` ON `capture_records` (`salesRoom`,`presentationStatus`,`scheduledAt`);