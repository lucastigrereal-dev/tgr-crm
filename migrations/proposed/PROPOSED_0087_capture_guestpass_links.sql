-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Numeracao: 0086 ja e o distrato/resgate (PROPOSED_0086_rescue_and_auto_cancellation); o desenho de 21/10 chamava esta de 0086 e foi renumerada para 0087.
-- Desenho: DESENHO_GUESTPASS_CRM_2026-10-21 (secao 5). F1.8 / CRM-a: vinculo unico entre o Nº do passe do GuestPass (GP- + 8 ou 10 hexadecimais) e a ficha.
-- Aditiva: 1 CREATE TABLE IF NOT EXISTS. Sem PII (so ids), sem backfill, nao altera customers nem capture_records. Atras de CRM_GUESTPASS_PREFILL_ENABLED=false.
-- A linha nunca e apagada; a anonimizacao da ficha nao a remove (nao tem dado pessoal). Um passe liga a UMA ficha e uma ficha a UM passe.
-- drizzle/schema.ts ja descreve a tabela (como couple_registry da 0079); o teste de drift compara so FKs do snapshot do journal.
-- ATENCAO: o rollback so pode ser usado em banco de TESTE ou SINTETICO. Rollback: DROP TABLE `capture_guestpass_links`;

CREATE TABLE IF NOT EXISTS `capture_guestpass_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`guestpassPassRef` varchar(13) NOT NULL,
	`contractVersion` int NOT NULL DEFAULT 1,
	`prefillFetchedAt` timestamp NULL,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_guestpass_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_guestpass_links_capture_unique` UNIQUE (`captureId`),
	CONSTRAINT `capture_guestpass_links_pass_unique` UNIQUE (`guestpassPassRef`),
	CONSTRAINT `capture_guestpass_links_captureId_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`),
	CONSTRAINT `capture_guestpass_links_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`),
	CONSTRAINT `capture_guestpass_links_passref_check` CHECK (`guestpassPassRef` REGEXP '^GP-([0-9A-F]{8}|[0-9A-F]{10})$')
);
