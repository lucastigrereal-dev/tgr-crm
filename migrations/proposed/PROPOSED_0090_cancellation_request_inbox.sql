-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus + backup antes de virar migration real.
-- M-A09-01a (Mandato 360): caixa de entrada dos pedidos de cancelamento vindos do Relationship, com protocolo persistido (o ACK).
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Atras de RELATIONSHIP_CANCELLATION_INBOX_ENABLED=false.
-- Sem texto livre e sem dado pessoal: contrato, codigo de motivo, ator opaco. Pedido NAO cria distrato nem libera fracao: so o CRM decide (cancellationRequestId liga ao fluxo existente).
-- Rollback: DROP TABLE cancellation_request_inbox;
CREATE TABLE IF NOT EXISTS `cancellation_request_inbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`protocol` varchar(36) NOT NULL,
	`eventId` varchar(120) NOT NULL,
	`requestId` varchar(120) NOT NULL,
	`payloadHash` varchar(64) NOT NULL,
	`contractId` int NOT NULL,
	`reasonCode` varchar(40) NOT NULL,
	`actor` varchar(120) NOT NULL,
	`requestedAt` timestamp(3) NOT NULL,
	`cancellationRequestId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cancellation_request_inbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `cancellation_request_inbox_protocol_unique` UNIQUE(`protocol`),
	CONSTRAINT `cancellation_request_inbox_event_unique` UNIQUE(`eventId`),
	CONSTRAINT `cancellation_request_inbox_request_unique` UNIQUE(`requestId`),
	CONSTRAINT `cancellation_request_inbox_contractId_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`),
	CONSTRAINT `cancellation_request_inbox_cancellationRequestId_fk` FOREIGN KEY (`cancellationRequestId`) REFERENCES `contract_cancellation_requests`(`id`),
	INDEX `cancellation_request_inbox_contract_idx` (`contractId`)
);
