# ETAPA 2 · E1 · Reserva da cota até a conferência

Status: proposta, flag `INVENTORY_HOLD_AT_FORMALIZATION` DESLIGADA por padrão. Parâmetros "provisório", editáveis por tela (admin), versionados.

## Regra
- Com a flag ligada, `contracts.create` e a ingestão do Sales (`sale.ready_for_contract`) não vendem a cota: ela fica `held` com um hold `purpose='formalization'` ligado ao contrato, com prazo.
- A cota vira `sold` somente na transação que fecha a SEGUNDA conferência (comprovante e documentação), `confirmPayment` ou `confirmDocuments`. Essa transação trava contrato -> sale_validations -> cota -> hold (mesma ordem do sweep), relê `paymentConfirmedAt` e `documentsConferredAt` sob `FOR UPDATE` e faz held -> sold só se o hold estiver ativo e não vencido.
- Prazo: política versionada `commercial_policy_versions` `policyType='stock_hold'`, `{ "ttlHours": 1..720 }` (estrito), padrão 48 h, vigente mais recente não aposentada.
- Hold vencido (na conferência ou pelo sweep): cota volta a `available`, `contracts.inventoryLostAt` é gravado, nasce tarefa de prioridade alta ao administrativo (`automationKey inventory-lost:<contractId>`) e auditoria. A conferência fica registrada; o administrativo recebe `INVENTORY_HELD_EXPIRED` (CONFLICT) e a validação final recusa o contrato.
- Distrato antes da conferência libera o hold ativo e devolve a cota.
- Hold da ingestão tem `heldByUserId` nulo.

## Contrato com o Sales (muda: Suite primeiro)
- `INVENTORY_HELD_EXPIRED` entra em `SALES_INGEST_REJECTION_CODES`, portanto na seção `sales` de `shared/contracts/tgr-events.snapshot.json` (`ingestRejection.codes`). O replay de um `saleId` cuja reserva foi perdida responde 422 `{accepted:false, code:"INVENTORY_HELD_EXPIRED", error}` em vez de 200 replay.
- Hash da seção sales: `a9567eb9...` -> `bfebebd0970a35a2a84005634d81e1ff6950747f85e23f51c269e46acb859fa7`. O re-pin está num commit separado; ordem Suite -> CRM -> re-pin. O Sales deve tratar 422 como "reserva vencida, refaça", sem retry cego e sem marcar a venda.
- Nenhum evento de saída novo (os eventos de cota são internos).

## Migração proposta 0074 (nada aplicado)
`commercial_fraction_holds.heldByUserId` nulável, `purpose`, `contractId`; `commercial_policy_versions.policyType` + `stock_hold`; `contracts.inventoryLostAt`. Rollback em `docs/rollback/0074_stock_hold_formalization.down.sql`, sobe-desce-sobe testado em MySQL descartável.

## Testes (MySQL)
`server/formalizationInventory.mysql.test.ts`: flag off vende na criação; reserva de 48 h e venda só após as duas conferências; política stock_hold (2 h, inválida recusada); dois contratos na mesma cota; hold vencido na segunda conferência (estoque, tarefa, erro, validação recusada, cota revendável); conferência final concorrente com sweep (3 rodadas, sem deadlock); conferências simultâneas vendem uma vez; ingestão reserva sem usuário, estoque insuficiente continua 422, replay com reserva perdida devolve 422.
