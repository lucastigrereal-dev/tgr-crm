-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Item 10 das configuracoes do admin: lista editavel e VERSIONADA dos indicadores oficiais do CRM (nome/descricao; a formula fica no codigo).
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill, sem tocar tabela existente. Atras de OFFICIAL_INDICATOR_CATALOG_ENABLED=false. Nenhuma mudanca na bridge/contrato do Relationship.
-- Rollback: DROP TABLE official_indicator_versions;
CREATE TABLE IF NOT EXISTS `official_indicator_versions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`version` int NOT NULL,
	`label` varchar(160) NOT NULL,
	`description` varchar(500) NOT NULL DEFAULT '',
	`active` boolean NOT NULL DEFAULT true,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `official_indicator_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `official_indicator_versions_code_version_unique` UNIQUE(`code`,`version`),
	CONSTRAINT `official_indicator_versions_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`)
);
