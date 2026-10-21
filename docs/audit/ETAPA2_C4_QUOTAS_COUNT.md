# ETAPA 2 / C4: `quotasCount` em `crm.sale.validated.v1` (21/10/2026)

Aditivo e opcional, no TOPO do corpo (não em `gates`): inteiro 1..100000 = cotas oficiais da venda. A Suite já aceita o campo desde o #138.

- **Origem**: na validação da venda (`saleValidationService.validateSale`) conta as frações ligadas ao contrato (`commercial_fractions.currentContractId`) e grava `quotasCount` no payload do evento interno `sale.validated`. Contrato sem fração (ex.: importado) não afirma nada: campo ausente. O Financial não muda: seu corpo é montado por whitelist (`contractId, saleId, validatedAt, validatedBy`).
- **Flag**: `SALE_VALIDATED_QUOTAS_COUNT_ENABLED` (padrão OFF). Desligada, o corpo enviado ao Sales é idêntico ao de antes. Ligada, `quotasCount` sai se for inteiro 1..100000; inválido/ausente é omitido (nunca recusa a venda).
- **Contrato**: `saleValidatedSampleBody` do `shared/contracts/tgr-events.snapshot.json` ganhou `quotasCount: 2` e o hash da seção `sales` de `consumers.lock.json` foi regenerado (financial e relationship inalterados).
- **Migration**: nenhuma.

## O que a Suite precisa fazer depois (NÃO feito aqui)
1. `node scripts/sync-crm-contract-fixtures.mjs <snapshot do CRM> <sha>` para sincronizar as fixtures.
2. Atualizar a seção `sales` em `scripts/crm-contract.lock.json` com o mesmo hash de `shared/contracts/consumers.lock.json`.
3. Re-pin de `crm-pair.sha` para o SHA do CRM com este PR. Bloqueado enquanto o CI da Suite estiver parado por cobrança do Actions.
4. PR-S5 da Suite (`sale_validations.quotas_count`, migration 0030 aditiva, não aplicar) passa a poder consumir o campo.
