-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real. Depende da PROPOSED_0080 (non_buyer_eligibility_state) ja aplicada.
-- F2.1 (fatia 5 do desenho ETAPA2_I): livro de ENTREGA dos eventos non_buyer.* ao Recovery. Uma linha por evento interno (eventId = idempotencyKey de domain_events).
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Sem PII: o corpo com nome/telefone e montado na hora do envio e nunca gravado aqui.
-- Tudo atras de NON_BUYER_DELIVERY_ENABLED=false (e RECOVERY_ELIGIBILITY_ENABLED).
-- Rollback: DROP TABLE non_buyer_deliveries;
CREATE TABLE IF NOT EXISTS `non_buyer_deliveries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`eventId` varchar(120) NOT NULL,
	`captureId` int NOT NULL,
	`seq` int NOT NULL,
	`kind` enum('eligible','revoked') NOT NULL,
	`status` enum('pending','delivered','superseded','suppressed','rejected') NOT NULL DEFAULT 'pending',
	`reason` varchar(60),
	`attempts` int NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp(3),
	`lastHttpStatus` smallint,
	`deliveredAt` timestamp(3),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `non_buyer_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `non_buyer_deliveries_event_unique` UNIQUE(`eventId`),
	CONSTRAINT `non_buyer_deliveries_captureId_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`),
	INDEX `non_buyer_deliveries_due_idx` (`status`,`nextAttemptAt`),
	INDEX `non_buyer_deliveries_capture_idx` (`captureId`,`kind`,`status`)
);
