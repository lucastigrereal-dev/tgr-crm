-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Desenho: docs/design/DISTRATO_E_RESGATE.md. Resgate pelo pos-vendas, distrato automatico configuravel (padrao desligado) e alertas juridicos (so alerta, nunca execucao).
-- Aditiva: 4 CREATE TABLE IF NOT EXISTS + 1 ALTER ADD COLUMN com DEFAULT. Sem backfill, sem alterar linha existente. Atras de RESCUE_QUEUE_ENABLED / AUTO_CANCELLATION_ENABLED = false.
-- NOTA: ao virar migration Drizzle, as 5 instrucoes precisam do separador de statements do drizzle (o marcador statement-breakpoint, ja presente entre elas abaixo); sem ele o 2o CREATE TABLE falha.
-- Para testar fora do drizzle com o cliente mysql, remova antes as linhas do marcador (o cliente mysql nao as aceita como comentario).
-- drizzle/schema.ts so ganha estas tabelas depois da migration aplicada (teste de drift).
-- ATENCAO: o rollback so pode ser usado em banco de TESTE ou SINTETICO, NUNCA com dado real (dado de casal/contrato nao se apaga).
-- Rollback (nesta ordem; a coluna e as tabelas novas nao tem dados de outros modulos):
--   ALTER TABLE contract_cancellation_requests DROP COLUMN origin;
--   DROP TABLE legal_action_alerts; DROP TABLE contract_rescue_attempts; DROP TABLE contract_rescue_cases; DROP TABLE retention_settings_versions;

-- Configuracao versionada e append-only (a vigente e a de maior id). Sem linha: padroes do codigo (3 meses, 15 dias, distrato automatico DESLIGADO).
CREATE TABLE IF NOT EXISTS `retention_settings_versions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`rescueWindowMonths` int NOT NULL DEFAULT 3,
	`rescueAlertLeadDays` int NOT NULL DEFAULT 15,
	`autoCancelEnabled` boolean NOT NULL DEFAULT false,
	`rescueReopenAfterDays` int NOT NULL DEFAULT 90,
	`autoCancelPromiseDays` int NOT NULL DEFAULT 15,
	`autoCancelMaxPaidPercent` int NOT NULL DEFAULT 30,
	`note` varchar(500),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `retention_settings_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `retention_settings_versions_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`),
	CONSTRAINT `retention_settings_window_check` CHECK (`rescueWindowMonths` BETWEEN 1 AND 24),
	CONSTRAINT `retention_settings_lead_check` CHECK (`rescueAlertLeadDays` BETWEEN 0 AND 365),
	CONSTRAINT `retention_settings_reopen_check` CHECK (`rescueReopenAfterDays` BETWEEN 1 AND 730),
	CONSTRAINT `retention_settings_promise_check` CHECK (`autoCancelPromiseDays` BETWEEN 0 AND 365),
	CONSTRAINT `retention_settings_paidpct_check` CHECK (`autoCancelMaxPaidPercent` BETWEEN 0 AND 100)
);
--> statement-breakpoint

-- Caso de resgate: no maximo UM aberto por contrato (activeKey unico; NULL quando fechado).
CREATE TABLE IF NOT EXISTS `contract_rescue_cases` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`reason` enum('overdue','reservation_expired') NOT NULL DEFAULT 'overdue',
	`status` enum('open','in_contact','due_for_cancellation','manual_review','rescued','dismissed','cancelled') NOT NULL DEFAULT 'open',
	`activeKey` varchar(40),
	`firstOverdueDate` date,
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`rescueDueAt` timestamp NOT NULL,
	`settingsVersionId` bigint,
	`assignedToUserId` int,
	`lastAttemptAt` timestamp,
	`closedAt` timestamp,
	`closedByUserId` int,
	`closeNote` varchar(500),
	`manualReviewReason` enum('domain_error','over_cap','paid_commission','open_renegotiation','recent_promise'),
	`manualReviewAt` timestamp,
	`suppressUntil` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contract_rescue_cases_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_rescue_cases_active_unique` UNIQUE (`activeKey`),
	CONSTRAINT `contract_rescue_cases_contractId_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`),
	CONSTRAINT `contract_rescue_cases_settings_fk` FOREIGN KEY (`settingsVersionId`) REFERENCES `retention_settings_versions`(`id`),
	CONSTRAINT `contract_rescue_cases_assignedToUserId_fk` FOREIGN KEY (`assignedToUserId`) REFERENCES `users`(`id`),
	CONSTRAINT `contract_rescue_cases_closedByUserId_fk` FOREIGN KEY (`closedByUserId`) REFERENCES `users`(`id`),
	INDEX `contract_rescue_cases_status_due_idx` (`status`,`rescueDueAt`),
	INDEX `contract_rescue_cases_contract_idx` (`contractId`,`id`),
	INDEX `contract_rescue_cases_suppress_idx` (`contractId`,`status`,`suppressUntil`)
);
--> statement-breakpoint

-- Tentativas de resgate do pos-vendas (append-only). Sem dado pessoal alem do autor; a nota e texto curto.
CREATE TABLE IF NOT EXISTS `contract_rescue_attempts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`caseId` bigint NOT NULL,
	`channel` enum('phone','message','email','visit','other') NOT NULL,
	`outcome` enum('no_answer','promised_payment','renegotiating','refused','other') NOT NULL,
	`note` varchar(500),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contract_rescue_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_rescue_attempts_caseId_fk` FOREIGN KEY (`caseId`) REFERENCES `contract_rescue_cases`(`id`),
	CONSTRAINT `contract_rescue_attempts_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`),
	INDEX `contract_rescue_attempts_case_idx` (`caseId`,`id`)
);
--> statement-breakpoint

-- Alerta juridico: SO pede decisao humana. Nenhuma execucao (cobranca judicial / negativacao) existe no codigo.
CREATE TABLE IF NOT EXISTS `legal_action_alerts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`kind` enum('judicial_collection','credit_bureau_listing') NOT NULL,
	`status` enum('open','decided_proceed','decided_dismissed') NOT NULL DEFAULT 'open',
	`activeKey` varchar(60),
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`decidedByUserId` int,
	`decidedAt` timestamp,
	`decisionNote` varchar(500),
	CONSTRAINT `legal_action_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `legal_action_alerts_active_unique` UNIQUE (`activeKey`),
	CONSTRAINT `legal_action_alerts_contractId_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`),
	CONSTRAINT `legal_action_alerts_decidedByUserId_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`),
	INDEX `legal_action_alerts_status_idx` (`status`,`openedAt`)
);
--> statement-breakpoint

-- Origem do pedido de distrato (manual hoje; automatico so quando o caminho automatico estiver ligado). Linhas existentes ficam 'manual'.
ALTER TABLE `contract_cancellation_requests` ADD COLUMN `origin` enum('manual','auto') NOT NULL DEFAULT 'manual';
