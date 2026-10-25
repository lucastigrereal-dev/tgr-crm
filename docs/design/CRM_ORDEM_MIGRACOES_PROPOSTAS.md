# Ordem de aplicação das migrations propostas do CRM (M-A06-03)

Estado: provado em banco DESCARTÁVEL (`server/proposedMigrationsOrder.mysql.test.ts`, SEM CI DO GITHUB). Nenhuma está aplicada em banco real; aplicar exige GO do Opus, backup e GO do Lucas, uma por vez.

Ordem única: numérica, 0078 → 0090. O journal do drizzle (0000–0077) vem antes. Cada arquivo só tem dependência de tabelas do journal ou de propostas de número menor.

| # | Arquivo | Efeito | Reaplicar |
|---|---|---|---|
| 0078 | installment_renegotiations_new_installment_id | coluna + FK em renegociações | falha (coluna/índice já existem) |
| 0079 | couple_registry_attendance | cadastro mestre do casal + atendimento | falha |
| 0080 | contact_optouts_eligibility_state | estado de elegibilidade do Recovery | falha |
| 0081 | official_indicator_versions | catálogo versionado de indicadores | falha |
| 0082 | capture_motives_recovery_kind | motivos de NT/recovery | falha |
| 0083 | commission_role_map | mapa de papéis de comissão | falha |
| 0084 | feature_flag_overrides | flags editáveis | falha |
| 0085 | role_permission_overrides | grants editáveis | falha |
| 0086 | rescue_and_auto_cancellation | resgate e distrato automático (OFF) | falha |
| 0087 | capture_guestpass_links | vínculo ficha ↔ passe (sem PII) | falha |
| 0088 | privacy_erasure_propagation | feed de exclusão LGPD | falha |
| 0089 | non_buyer_deliveries | caixa de entrega ao Recovery (estado dead) | falha |
| 0090 | cancellation_request_inbox | caixa do pedido de cancelamento + ACK | falha |

- Aplicar do zero: journal + propostas em ordem passa sem erro. Reaplicar o journal não muda nada. Reaplicar uma proposta falha com erro claro de duplicidade e não altera o esquema.
- Nunca `drizzle-kit push` em banco real. Uma migration por GO, com backup antes.
- Mudar `nqReadEndpoint`/`encounterTimesReceiver` exige re-pin do `crm-extra-contracts.lock.json` na Suite.
