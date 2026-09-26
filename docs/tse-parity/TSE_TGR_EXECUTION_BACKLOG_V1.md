# TSE -> TGR Execution Backlog V1

**Data:** 2026-09-26  
**Fonte:** `TSE_TGR_PARITY_MATRIX_V1.md`

## Regra

Este backlog existe para fechar o **cutover do TSE**, não para inflar feature list. Toda entrega precisa de código, teste, evidência e dono operacional.

| ID | Dono | Entrega | Escopo | Aceite |
|---|---|---|---|---|
| P0-01 | CRM | Estoque comercial de 3.120 cotas/frações | Criar commercialFractions, status, UH, número de fração, tabela/preço vigente, vínculo a contrato e auditoria. | 60 UH x 52 podem ser carregadas; nenhuma fração pode ser vendida duas vezes; cancelamento retorna conforme política. |
| P0-02 | CRM | Hold transacional de fração | Reserva temporária de cota durante proposta/closing com TTL e concorrência. | Duas sessões concorrentes não conseguem confirmar a mesma fração. |
| P0-03 | CRM + Financial | Motor de reajuste/indexação | Políticas versionadas para INCC/IGP-M e regras contratuais configuráveis. | Simulação e aplicação geram memória de cálculo e nunca alteram histórico silenciosamente. |
| P0-04 | CRM | E-sign real | Adapter DocuSign/Clicksign/AssineOnline com envelope, webhook e reconciliação. | Contrato percorre estados externos, retry não duplica e assinatura final é auditável. |
| P0-05 | CRM | Asaas homologado | Executar sandbox e homologação real do adapter já implementado. | PIX/boleto geram cobrança, webhook baixa uma vez e falhas têm reconciliação. |
| P0-06 | CRM | E2E recepção | Rodar seed + E2E_STRICT da jornada fila -> chegada -> mesa -> início -> fim/NT. | Teste autenticado verde em banco descartável. |
| P0-07 | CRM | E2E distrato | Provar request -> decisão -> execução única -> efeitos financeiros/comissão/direito. | Repetição é idempotente e rollback preserva consistência. |
| P0-08 | CRM + Suite | Integração Financial | Finalizar PRs pareados somente quando Financial Layer estiver verde. | Eventos financeiros chegam uma vez, project key é canônico e reconciliação fecha. |
| P0-09 | Portal | Portal do Proprietário | App externo separado consumindo CRM/Relationship com escopo do proprietário. | Contrato, documentos, parcelas/2ª via, direitos, reservas e solicitações funcionam sem acesso administrativo. |
| P0-10 | Dados | Migração e 103 campos | Recuperar matriz fonte, mapear campo a campo e reconciliar histórico. | 100% dos 103 campos têm decisão e totais financeiros/operacionais conciliam. |
| P1-01 | CRM | Contatos e endereços N:N | Normalizar telefones/e-mails/endereços com preferencial, validade e histórico. | Cobrança e relacionamento escolhem canal/endereço correto sem sobrescrever histórico. |
| P1-02 | CRM | Dicionários de referência | Profissão, veículo, hotel, local de captação, forma de pagamento e outros campos analíticos controlados. | Alias e versionamento evitam fragmentação sem bloquear captação. |
| P1-03 | CRM + Relationship | Ledger de pontos | Movimentos append-only: crédito, consumo, estorno, expiração e rollover. | Saldo é sempre derivável dos movimentos e reserva referencia o débito. |
| P1-04 | Relationship + Portal | Intercâmbio | Workflow de solicitação/partner/confirm/cancel/reconcile. | Nenhum intercâmbio altera direito sem evento e vínculo auditável. |
| P1-05 | Suite | Mensageria | Provider WhatsApp/SMS/e-mail para Relationship e Recovery. | Consentimento, opt-out, template, idempotência, delivery status e auditoria. |
| P1-06 | CRM | Voucher/brinde | Entidade de voucher, parceiro, custo, validade, emissão e resgate. | Custo do brinde é rastreável até tour/venda/D90. |
| P1-07 | Suite | Integration Operations Console | Painel único de inbox/outbox/retry/dead-letter/reconciliação. | Operador identifica e reprocessa falha sem acesso ao banco. |
| P1-08 | CRM | PMS/ERP adapters | Selecionar sistemas reais e criar adapters governados. | Health/retry/idempotência/reconciliação comprovados. |
| P1-09 | CRM | Comissão multipapel opcional | Generalizar split para supervisor/gerente/recaptura quando política exigir. | Política versionada calcula e explica cada parcela sem hardcode de operação. |
| P2-01 | CRM / BI | Relatórios ad hoc | Fechar catálogo de relatórios obrigatórios e exports reproduzíveis. | Usuário não precisa do TSE só para um relatório legado necessário. |

## Ordem recomendada

### Wave A - corte do legado comercial
P0-01 -> P0-02 -> P0-06 -> P0-07 -> P0-10

### Wave B - contrato e caixa
P0-03 -> P0-04 -> P0-05 -> P0-08

### Wave C - proprietário
P0-09 -> P1-03 -> P1-04 -> P1-05

### Wave D - maturidade operacional
P1-01 -> P1-02 -> P1-06 -> P1-07 -> P1-08 -> P1-09 -> P2-01

## O que não fazer

- Não duplicar cliente/contrato em Sales Command, Relationship ou Portal.
- Não contar Financial Layer PR aberto como produção.
- Não reconstruir telas do TSE sem necessidade operacional.
- Não importar a coorte parcial de 68 casais como histórico completo.
- Não aplicar política financeira “default” quando a operação não aprovou a regra.
- Não desligar o TSE antes de reconciliação e rollback.
