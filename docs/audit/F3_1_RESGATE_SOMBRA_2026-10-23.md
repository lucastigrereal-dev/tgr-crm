# F3.1: resgate e distrato automático em MODO SOMBRA

Fonte do desenho: `docs/design/DISTRATO_E_RESGATE.md` (#118). Migration: `migrations/proposed/PROPOSED_0086_rescue_and_auto_cancellation.sql` (PROPOSTA, nunca aplicada pelo agente; o teste a aplica inteira em banco descartável).

## O que existe
- Flag `RESCUE_QUEUE_ENABLED` (nasce OFF; compose, `.env.example`, deny-list da tela de flags). Liga o job de varredura (30 min), as rotas `rescue.*` e a aba "Resgate e distrato" em Configurações da empresa.
- `AUTO_CANCELLATION_ENABLED` está declarada e RESERVADA: nenhum código a lê para agir. Distrato automático real é F4, com GO.
- Estados do caso: `open`, `in_contact`, `due_for_cancellation`, `manual_review`, `rescued`, `dismissed`, `cancelled`. Um caso aberto por contrato (`activeKey`). Supressão após `dismissed` (`rescueReopenAfterDays`), com reabertura por parcela nova vencida.
- Configuração versionada com histórico (prazo, antecedência do alerta, reabertura, tetos de promessa e de valor pago, liga/desliga do ensaio). Padrões PROVISÓRIOS (3 meses, 15 dias, 90 dias, 15 dias, 30%) até o modelo de contrato do Lucas; nada depende desse modelo.
- Eventos internos (sem entrega externa, fora das pontes, payload só com ids/datas/códigos): `contract.rescue.opened|attempted|due_soon|resolved`, `contract.auto_cancellation.would_run`.
- Capacidades: `rescue.work` (admin, service) e `rescue.configure` (admin).

## O que NÃO faz (travado por teste)
O módulo não importa nem chama pedido/decisão/execução de distrato, não altera contrato, parcela, comissão, estoque nem lançamento financeiro. Com o ensaio ligado, o prazo vencido sem teto violado só grava `would_run`; com teto violado, o caso vai a `manual_review` com o motivo. Cobrança judicial e negativação não existem (alerta jurídico fica para a próxima fatia).

## Pendências (decisão do Lucas / próximas fatias)
Modelo da reserva vencida (`reason = reservation_expired`), destinatário do alerta jurídico, tela do pós-vendas para a fila (as rotas existem), coluna `origin` e ator de sistema (F4), ensaio com 50 contratos sintéticos (F3.3).
