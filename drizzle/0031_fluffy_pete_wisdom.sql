ALTER TABLE `tasks` ADD `automationKey` varchar(255);--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_automation_key_unique` UNIQUE(`automationKey`);