# ETAPA 2 · H1 · Comprovante/recebimento declarado não é dinheiro recebido

Status: proposta, tudo atrás de padrão seguro. Comissão monetária segue TRAVADA; `COMMISSION_V2_RELEASED` não foi tocada.

## O que muda
- `installments.settlementEvidence` (migração proposta 0075, padrão `receipt_claimed`): `receipt_claimed` (recebimento declarado: baixa manual, entrada informada pelo Sales), `gateway_confirmed` (webhook do gateway) e `bank_reconciled` (conciliado com o extrato). A evidência só sobe.
- Webhook Asaas confirmado grava `gateway_confirmed`. `finance.reconcileEntry` promove a `bank_reconciled` as parcelas pagas do contrato cuja soma recebida fecha exatamente com o lançamento; soma que não fecha não promove e deixa auditoria (`reconcile_installments_ambiguous`).
- Sales: `entryReceiptClaimedCents` é o nome novo do que era `entryReceivedCents` (aceitos os dois; se vierem os dois, devem ser iguais). O valor é sempre tratado como DECLARADO; a parcela nasce `receipt_claimed`.
- Rótulos: "Comprovante conferido (não é recebimento)" (C1) e, no detalhe do contrato, "Recebimento declarado / Confirmado pelo gateway / Conciliado com o extrato" ao lado de cada parcela com valor pago.
- Política de comissão (F1 consome): `requiredEvidence` com padrão `receipt_claimed` (`requiredEvidenceOf`, `evidenceSatisfies` em `server/settlementEvidence.ts`). Nada é bloqueado agora.

## Contrato (muda: Suite/Financial primeiro)
- `installment.paid` ganha o campo OPCIONAL `settlementEvidence`, emitido somente com `INSTALLMENT_EVIDENCE_IN_EVENT=true` (padrão false). O Financial precisa aceitá-lo antes de a flag ligar.
- `shared/integrationContract.ts` inclui o campo na lista permitida, então a seção `financial` do snapshot muda: hash `141f940e...` -> `6aad5c8a3fb6b04720b4f9c2cdf918401cdc89b9717323dd978b7e657dad9ea8`. Re-pin em commit separado (ordem Suite -> CRM -> re-pin). Seção `sales` não muda além do E1.

## Migração proposta 0075 (nada aplicado)
Rollback `docs/rollback/0075_installment_settlement_evidence.down.sql` (apaga a coluna; desligar a flag antes), sobe-desce-sobe testado em MySQL descartável.

## Testes
`server/settlementEvidence.test.ts` (ordem, requiredEvidence, soma exata, alias do Sales) e `server/settlementEvidence.mysql.test.ts` (baixa manual, flag no evento, webhook, conciliação exata e ambígua).
