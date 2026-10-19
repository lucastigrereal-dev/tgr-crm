-- Desfaz 0068 (tabela payment_gateway_issue_intents, CRM-A10). A tabela só guarda intenções de emissão no gateway; nenhuma outra tabela a referencia.
-- ATENÇÃO: intenções com status 'pending' ou 'manual_review' indicam cobrança possivelmente criada no Asaas e não registrada aqui. Antes de
-- descer, rode a recuperação (job de reconciliação) ou confira esses registros: depois do DROP essa trilha some. Pode ser repetido.
DROP TABLE IF EXISTS `payment_gateway_issue_intents`;
--> statement-breakpoint
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1792450159127;
