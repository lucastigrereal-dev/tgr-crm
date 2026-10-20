-- Desfaz 0072 (sale_validator_grants, CRM-C1): remove as concessões de "administrativo autorizado".
-- Efeito: o papel finance deixa de poder conferir comprovante e validar vendas (só admin segue autorizado). Vendas já validadas não mudam; a trilha em
-- sale_validation_events/audit_logs permanece. Exporte a tabela antes se precisar do histórico das concessões. Pode ser repetido.
DROP TABLE IF EXISTS `sale_validator_grants`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792530460907;
