-- Rollback da migração 0063 (LGPD da ficha: custódia do papel recolhido/destruído e textos do aviso de privacidade).
-- Perde o registro de recolhimento/destruição gravado nas colunas novas; as impressões, as fichas e o resto do CRM não mudam.
-- Só apaga as 7 chaves de configuração enquanto ainda forem provisórias: valor que a administração já definiu fica.
-- A última linha tira a 0063 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
DROP INDEX `capture_sheet_prints_printed_idx` ON `capture_sheet_prints`;
--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` DROP FOREIGN KEY `capture_sheet_prints_collectedByUserId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` DROP FOREIGN KEY `capture_sheet_prints_destroyedByUserId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `capture_sheet_prints` DROP COLUMN `collectedAt`, DROP COLUMN `collectedByUserId`, DROP COLUMN `destroyedAt`, DROP COLUMN `destroyedByUserId`;
--> statement-breakpoint
DELETE FROM `capture_sheet_settings` WHERE `provisional` = true AND `key` IN ('room_visibility_days','paper_destroy_deadline_days','privacy_controller_name','privacy_controller_cnpj','privacy_contact_channel','privacy_full_text_url','privacy_retention_text');
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792254082875;
