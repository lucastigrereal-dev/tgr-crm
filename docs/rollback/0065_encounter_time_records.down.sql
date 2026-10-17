-- Desfaz 0065: só remove a tabela de tempos de sala recebidos do Sales Command. Os tempos recebidos ficam apenas lá; o Sales reenvia o evento se precisar.
DROP TABLE `encounter_time_records`;
DELETE FROM __drizzle_migrations WHERE created_at = 1792264501013;
