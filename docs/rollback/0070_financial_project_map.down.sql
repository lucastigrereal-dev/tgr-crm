-- Desfaz 0070 (financial_project_map, CRM-A01): remove o mapa empreendimento -> projeto do Financial.
-- Sem o mapa a ponte volta a usar o projeto padrão (env) para todos os contratos. Se FINANCIAL_PROJECT_MAP_ENABLED=true estava em uso, eventos já entregues
-- a outros projetos do Financial NÃO são desfeitos: confira com o Financial antes. Pode ser repetido.
DROP TABLE IF EXISTS `financial_project_map`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792526402290;
