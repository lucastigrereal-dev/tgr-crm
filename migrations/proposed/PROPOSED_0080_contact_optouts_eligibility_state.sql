-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- C2/C3 fatia 2 (docs/audit/ETAPA2_I_DESENHO_ELEGIBILIDADE_RECOVERY.md §3.2 e §3.4): opt-out de contato (append-only) e projecao de elegibilidade de nao-comprador.
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Tudo atras de RECOVERY_ELIGIBILITY_ENABLED=false.
-- Rollback: DROP TABLE non_buyer_eligibility_state; DROP TABLE customer_contact_optouts;
-- customer_contact_optouts: valida por CLIENTE (vale para todas as fichas dele). Sem texto livre. `eventId` unico quando existe (recovery); crm_staff/owner_request
-- podem ficar sem eventId (MySQL aceita varios NULL no unique). Opt-out nao e revertido por esta tabela: reativacao depende de decisao do Lucas (pendente).
CREATE TABLE IF NOT EXISTS `customer_contact_optouts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`coupleCode` varchar(64) NOT NULL,
	`optedOutAt` timestamp(3) NOT NULL,
	`source` enum('crm_staff','recovery','owner_request') NOT NULL,
	`eventId` varchar(120),
	`payloadHash` varchar(64),
	`reasonCode` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customer_contact_optouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_contact_optouts_event_unique` UNIQUE(`eventId`),
	CONSTRAINT `customer_contact_optouts_customerId_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
	INDEX `customer_contact_optouts_customer_idx` (`customerId`,`optedOutAt`)
);
--> statement-breakpoint
-- non_buyer_eligibility_state: uma linha por ficha (a linha travada com SELECT ... FOR UPDATE por gancho e reconciliacao). `customerId` e existe para a
-- reavaliacao poder ser disparada tambem por mudanca de CONTRATO, PROPOSTA ou OPORTUNIDADE (que conhecem o cliente, nao a ficha): cliente -> fichas -> reavaliar.
CREATE TABLE IF NOT EXISTS `non_buyer_eligibility_state` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`customerId` int NOT NULL,
	`eligible` boolean NOT NULL DEFAULT false,
	`seq` int NOT NULL DEFAULT 0,
	`lastReason` varchar(40),
	`lastEmittedAt` timestamp(3),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `non_buyer_eligibility_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `non_buyer_eligibility_state_capture_unique` UNIQUE(`captureId`),
	CONSTRAINT `non_buyer_eligibility_state_captureId_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`),
	CONSTRAINT `non_buyer_eligibility_state_customerId_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
	INDEX `non_buyer_eligibility_state_customer_idx` (`customerId`)
);
