CREATE TABLE `encounter_time_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` varchar(120) NOT NULL,
	`captureId` int NOT NULL,
	`coupleCode` varchar(64) NOT NULL,
	`correlationId` varchar(120) NOT NULL,
	`payloadHash` varchar(64) NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`waitStartedAt` timestamp,
	`waitEndedAt` timestamp,
	`consultantStartedAt` timestamp,
	`consultantEndedAt` timestamp,
	`consultantDispensed` boolean NOT NULL DEFAULT false,
	`closerStartedAt` timestamp,
	`closerEndedAt` timestamp,
	`endedAt` timestamp,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `encounter_time_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `encounter_time_records_event_unique` UNIQUE(`eventId`)
);
--> statement-breakpoint
ALTER TABLE `encounter_time_records` ADD CONSTRAINT `encounter_time_records_captureId_capture_records_id_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `encounter_time_records_capture_idx` ON `encounter_time_records` (`captureId`,`occurredAt`);