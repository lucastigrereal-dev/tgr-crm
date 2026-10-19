-- Desfaz 0065: só remove a tabela de tempos de sala recebidos do Sales Command. Os tempos recebidos ficam apenas lá; o Sales reenvia o evento se precisar.
-- Cada passo confere se o objeto existe antes de apagar (DROP ... IF EXISTS, e information_schema para coluna, índice e chave, que o MySQL não aceita com IF EXISTS):
-- o script roda inteiro mesmo em estado parcial (migração que parou no meio, ou rollback já feito em parte) e pode ser repetido.
DROP TABLE IF EXISTS `encounter_time_records`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792264501013;
