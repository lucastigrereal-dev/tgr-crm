-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- C1: registro canonico do casal + historico de atendimentos recebidos de `encounter.attendance_recorded.v1` (Sales -> CRM).
-- closedAt/occurredAt em timestamp(3): o contrato aceita ISO com fracao e o desempate do "ultimo atendimento" depende dela.
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Receptor desligado por ATTENDANCE_RECEIVER_ENABLED=false.
-- Rollback: DROP TABLE attendance_records; DROP TABLE couple_registry; (nessa ordem).
CREATE TABLE IF NOT EXISTS `couple_registry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`salesCoupleId` varchar(36) NOT NULL,
	`coupleCode` varchar(32) NOT NULL,
	`primaryName` varchar(160),
	`secondaryName` varchar(160),
	`phoneDigits` varchar(64),
	`lastEncounterId` varchar(36) NOT NULL,
	`lastRevision` int NOT NULL,
	`lastOutcome` enum('SALE_CONFIRMED','NO_SALE','CAIU_EM_MESA','NT') NOT NULL,
	`lastReasonCode` varchar(100),
	`lastClosedAt` timestamp(3) NOT NULL,
	`encountersCount` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `couple_registry_id` PRIMARY KEY(`id`),
	CONSTRAINT `couple_registry_resort_couple_unique` UNIQUE(`resortId`,`salesCoupleId`),
	CONSTRAINT `couple_registry_resortId_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`),
	INDEX `couple_registry_resort_code_idx` (`resortId`,`coupleCode`),
	INDEX `couple_registry_phone_idx` (`phoneDigits`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attendance_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`coupleRegistryId` int NOT NULL,
	`encounterId` varchar(36) NOT NULL,
	`revision` int NOT NULL,
	`outcome` enum('SALE_CONFIRMED','NO_SALE','CAIU_EM_MESA','NT') NOT NULL,
	`reasonCode` varchar(100),
	`closedAt` timestamp(3) NOT NULL,
	`occurredAt` timestamp(3) NOT NULL,
	`correlationId` varchar(128) NOT NULL,
	`payloadHash` varchar(64) NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attendance_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_records_event_unique` UNIQUE(`eventId`),
	CONSTRAINT `attendance_records_encounter_revision_unique` UNIQUE(`encounterId`,`revision`),
	CONSTRAINT `attendance_records_coupleRegistryId_fk` FOREIGN KEY (`coupleRegistryId`) REFERENCES `couple_registry`(`id`),
	INDEX `attendance_records_couple_idx` (`coupleRegistryId`,`closedAt`)
);
