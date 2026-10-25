# Ordem de aplicação das migrations propostas do CRM (M-A06-03)

Estado: provado em banco DESCARTÁVEL (`server/proposedMigrationsOrder.mysql.test.ts`, SEM CI DO GITHUB). Nenhuma está aplicada em banco real; aplicar exige GO do Opus, backup e GO do Lucas, uma por vez.

Ordem única: numérica, 0078 → 0090. O journal do drizzle (0000–0077) vem antes. Cada arquivo só tem dependência de tabelas do journal ou de propostas de número menor.

| # | Arquivo | Efeito | Se reaplicar |
|---|---|---|---|
| 0078 | installment_renegotiations_new_installment_id | coluna + FK em renegociações | falha (coluna/índice já existem) |
| 0079 | couple_registry_attendance | cadastro mestre do casal + atendimento | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0080 | contact_optouts_eligibility_state | estado de elegibilidade do Recovery | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0081 | official_indicator_versions | catálogo versionado de indicadores | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0082 | capture_motives_recovery_kind | motivos de NT/recovery | passa em silêncio (MODIFY COLUMN idêntico) |
| 0083 | commission_role_map | mapa de papéis de comissão | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0084 | feature_flag_overrides | flags editáveis | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0085 | role_permission_overrides | grants editáveis | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0086 | rescue_and_auto_cancellation | resgate e distrato automático (OFF) | tabelas passam em silêncio; o ALTER ADD COLUMN `origin` falha (coluna já existe) |
| 0087 | capture_guestpass_links | vínculo ficha ↔ passe (sem PII) | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0088 | privacy_erasure_propagation | feed de exclusão LGPD | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0089 | non_buyer_deliveries | caixa de entrega ao Recovery (estado dead) | passa em silêncio (CREATE TABLE IF NOT EXISTS) |
| 0090 | cancellation_request_inbox | caixa do pedido de cancelamento + ACK | passa em silêncio (CREATE TABLE IF NOT EXISTS) |

- Aplicar do zero: journal + propostas em ordem passa sem erro. Reaplicar o journal não muda nada. Reaplicar NÃO é um sinal confiável: 0078 e o ALTER do 0086 falham com erro de duplicidade, mas as demais passam em silêncio (CREATE TABLE IF NOT EXISTS ou MODIFY idêntico). Um retry que passou não prova que a proposta nunca tinha sido aplicada; antes de aplicar, conferir o estado do banco (SHOW CREATE TABLE) e o backup.
- Nunca `drizzle-kit push` em banco real. Uma migration por GO, com backup antes.
- Mudar `nqReadEndpoint`/`encounterTimesReceiver` exige re-pin do `crm-extra-contracts.lock.json` na Suite.
