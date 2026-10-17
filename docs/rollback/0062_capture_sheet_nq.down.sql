-- Rollback da migração 0062 (ficha impressa: campos do casal qualificado, tipo de veículo, limites configuráveis).
-- Perde o que foi gravado nas colunas e na tabela novas; as fichas e o resto do CRM não mudam.
-- A última linha tira a 0062 da tabela de controle do drizzle; sem ela, um novo deploy pularia a migração.
-- O papel `supervisor_vendas` fica: pode ter sido criado pela administração antes da 0062 e já ter vínculos; sozinho ele não faz mal.
DROP TABLE `capture_sheet_settings`;
--> statement-breakpoint
ALTER TABLE `capture_records` DROP COLUMN `maleSpouse`, DROP COLUMN `vehicleKind`, DROP COLUMN `secondVehicleKind`, DROP COLUMN `watchedVacationPresentation`, DROP COLUMN `captureKind`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792252638771;
