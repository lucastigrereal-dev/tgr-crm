-- Desfaz 0067 (valor 'promoter' em sales_commissions.commissionRole, CRM-A13): volta o enum para liner, closer e ftb.
-- ATENÇÃO: se já existe comissão com papel 'promoter' o MySQL recusa o MODIFY (Data truncated) e NADA muda: o rollback não apaga comissão
-- para caber no enum. Resolva as linhas 'promoter' (decisão humana) antes de repetir. A política V2 nasce travada (COMMISSION_V2_RELEASED=false),
-- então em ambiente que nunca liberou o V2 não existe linha 'promoter' e o rollback passa direto. Pode ser repetido.
ALTER TABLE `sales_commissions` MODIFY COLUMN `commissionRole` enum('liner','closer','ftb') NOT NULL DEFAULT 'ftb';
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792449836993;
