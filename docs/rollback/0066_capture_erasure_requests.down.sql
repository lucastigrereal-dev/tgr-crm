-- Desfaz 0066 (pedido de exclusão/anonimização da ficha, CRM-A18): remove a tabela de pedidos, as colunas anonymizedAt e a semente do encarregado.
-- ATENÇÃO: o que já foi anonimizado NÃO volta (o dado pessoal foi apagado de verdade). Isto só tira a trilha dos pedidos e a marca anonymizedAt.
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
DROP TABLE IF EXISTS `capture_erasure_requests`;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `capture_records` DROP COLUMN `anonymizedAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_records' AND COLUMN_NAME = 'anonymizedAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE `customers` DROP COLUMN `anonymizedAt`', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'anonymizedAt');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- A tabela de limites só existe se a 0062 ainda está aplicada.
SET @s = (SELECT IF(COUNT(*) > 0, 'DELETE FROM `capture_sheet_settings` WHERE `provisional` = true AND `updatedByUserId` IS NULL AND `key` = ''privacy_dpo_name''', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capture_sheet_settings');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792438583970;
