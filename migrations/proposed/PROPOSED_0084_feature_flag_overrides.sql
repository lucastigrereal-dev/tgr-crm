-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Item 6 das configuracoes do admin: sobrescrita (ligar/desligar) de flags da ALLOW-LIST pela tela, com historico de quem mudou. Aditiva, sem backfill.
-- Atras de FEATURE_FLAG_OVERRIDES_ENABLED=false. COMMISSION_V2_RELEASED e flags de seguranca/auth/chave nunca entram aqui (deny-list no codigo).
-- Rollback: DROP TABLE feature_flag_overrides;
CREATE TABLE IF NOT EXISTS `feature_flag_overrides` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`flagKey` varchar(60) NOT NULL,
	`enabled` boolean NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `feature_flag_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `feature_flag_overrides_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`),
	INDEX `feature_flag_overrides_key_idx` (`flagKey`,`id`)
);
