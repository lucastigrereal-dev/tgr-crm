-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Item 4 das configuracoes do admin: permissao por papel EDITAVEL por ACAO (capacidades `export.pii`, `sheet.archived.open`, `document.read`, `commission.view`), versionada e append-only
-- (quem mudou e quando ficam na linha). Telas (menu) ficam FIXAS por enquanto. Aditiva, sem backfill. Atras de PERMISSION_OVERRIDES_ENABLED=false (fora da tela de flags).
-- Piso fixo no codigo (shared/permissions.ts): admin sempre presente, capacidades criticas nao editaveis.
-- Rollback: DROP TABLE role_permission_overrides;
CREATE TABLE IF NOT EXISTS `role_permission_overrides` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`permKey` varchar(80) NOT NULL,
	`roles` varchar(120) NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `role_permission_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `role_permission_overrides_createdByUserId_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`),
	INDEX `role_permission_overrides_key_idx` (`permKey`,`id`)
);
