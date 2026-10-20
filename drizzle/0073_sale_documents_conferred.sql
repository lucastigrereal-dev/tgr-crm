ALTER TABLE `sale_validations` ADD `documentsConferredAt` timestamp;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `documentsConferredByUserId` int;--> statement-breakpoint
ALTER TABLE `sale_validations` ADD `documentsConferredNote` text;