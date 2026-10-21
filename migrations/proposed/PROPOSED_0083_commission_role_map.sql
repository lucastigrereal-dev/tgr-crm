-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Item 5 das configuracoes do admin: mapa de papeis da comissao V2 (captador/consultor/fechador -> promoter/liner/closer) como configuracao VERSIONADA, com snapshot por contrato.
-- Aditiva (so CREATE TABLE IF NOT EXISTS), sem backfill. Atras de COMMISSION_ROLE_MAP_ENABLED=false e so lida com COMMISSION_V2_RELEASED=true (hoje travada).
-- Rollback: DROP TABLE contract_commission_role_maps; DROP TABLE commission_role_map_versions;
CREATE TABLE IF NOT EXISTS `commission_role_map_versions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`version` int NOT NULL,
	`roleMap` varchar(255) NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `commission_role_map_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `commission_role_map_versions_version_unique` UNIQUE(`version`),
	CONSTRAINT `commission_role_map_versions_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
-- contractId e a propria chave (sem AUTO_INCREMENT): o snapshot nasce uma vez por contrato.
CREATE TABLE IF NOT EXISTS `contract_commission_role_maps` (
	`contractId` int NOT NULL,
	`mapVersion` int NOT NULL,
	`roleMap` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contract_commission_role_maps_contractId` PRIMARY KEY(`contractId`),
	CONSTRAINT `contract_commission_role_maps_contractId_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`)
);
