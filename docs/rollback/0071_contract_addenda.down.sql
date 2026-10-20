-- Desfaz 0071 (contract_addenda, CRM-A12): remove o histórico de aditivos não monetários.
-- ATENÇÃO: aditivos 'signed' já aplicaram efeito (ex.: contato do associado) e o histórico/antes-depois some com a tabela; a trilha em audit_logs permanece.
-- Só desça com CONTRACT_ADDENDUM_ENABLED=false e depois de exportar a tabela se houver aditivo assinado. Pode ser repetido.
DROP TABLE IF EXISTS `contract_addenda`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792526425325;
