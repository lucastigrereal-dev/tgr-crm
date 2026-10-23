-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- F2.10 (lado CRM): exclusao LGPD propagada. Desenho: docs/design/PRIVACY_ERASURE_PROPAGADA_CRM.md (e docs/design/ERASURE_PROPAGADA.md do GuestPass, PR GuestPass #35).
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Atras de PRIVACY_ERASURE_PROPAGATION_ENABLED=false.
-- Sem PII em claro: o titular e identificado por HMAC do CPF (cpfHmac), apagado (NULL) quando o pedido termina. Nunca guarda nome, CPF, telefone nem texto livre do pedido.
-- Numeracao: 0087 e do GuestPass link (#121); esta usa 0088.
-- Rollback (so banco de teste ou sintetico): DROP TABLE privacy_erasure_receipts; DROP TABLE privacy_erasure_events;
CREATE TABLE IF NOT EXISTS `privacy_erasure_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`eventId` varchar(120) NOT NULL,
	`source` enum('guestpass') NOT NULL DEFAULT 'guestpass',
	`externalRef` varchar(40),
	`externalRequestId` int,
	`mode` enum('minimal','full') NOT NULL,
	`cpfHmac` varchar(64),
	`status` enum('received','done','partial','nothing_to_erase','needs_human') NOT NULL DEFAULT 'received',
	`customersMatched` int NOT NULL DEFAULT 0,
	`customersAnonymized` int NOT NULL DEFAULT 0,
	`detail` varchar(200),
	`requestedAt` timestamp,
	`fulfilledAt` timestamp,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `privacy_erasure_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `privacy_erasure_events_event_unique` UNIQUE(`eventId`),
	INDEX `privacy_erasure_events_status_idx` (`status`,`id`)
);
--> statement-breakpoint
-- Recibo por sistema (crm, sales, recovery, relationship, financial). `deliveredAt` marca quando o recibo chegou ao GuestPass (NULL = reenviar na proxima rodada). Idempotente por (eventId, system).
CREATE TABLE IF NOT EXISTS `privacy_erasure_receipts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`eventId` varchar(120) NOT NULL,
	`system` enum('crm','sales','recovery','relationship','financial') NOT NULL,
	`status` enum('done','partial','failed','nothing_to_erase') NOT NULL,
	`detail` varchar(200),
	`receiptAt` timestamp NOT NULL DEFAULT (now()),
	`deliveredAt` timestamp,
	CONSTRAINT `privacy_erasure_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `privacy_erasure_receipts_event_system_unique` UNIQUE(`eventId`,`system`),
	INDEX `privacy_erasure_receipts_pending_idx` (`system`,`deliveredAt`)
);
