CREATE TABLE `domain_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventName` varchar(120) NOT NULL,
	`aggregateType` varchar(80) NOT NULL,
	`aggregateId` varchar(80) NOT NULL,
	`actorUserId` int,
	`payload` text,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `domain_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `domain_events` ADD CONSTRAINT `domain_events_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `domain_events_aggregate_idx` ON `domain_events` (`aggregateType`,`aggregateId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `domain_events_name_idx` ON `domain_events` (`eventName`,`occurredAt`);