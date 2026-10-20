# ETAPA 2 · H1 · Comprovante/recebimento declarado não é dinheiro recebido

Status: proposta, tudo atrás de padrão seguro. Comissão monetária segue TRAVADA; `COMMISSION_V2_RELEASED` não foi tocada.

## O que muda
- `installments.settlementEvidence` (migração proposta 0075, padrão `receipt_claimed`): `receipt_claimed` (recebimento declarado: baixa manual, entrada informada pelo Sales), `gateway_confirmed` (webhook do gateway) e `bank_reconciled` (conciliado com o extrato). A evidência só sobe.
- Webhook Asaas confirmado grava `gateway_confirmed`. `finance.reconcileEntry` promove a `bank_reconciled` as parcelas pagas do contrato cuja soma recebida fecha exatamente com o lançamento; soma que não fecha não promove e deixa auditoria (`reconcile_installments_ambiguous`).
- Sales: `entryReceiptClaimedCents` é o nome novo do que era `entryReceivedCents` (aceitos os dois; se vierem os dois, devem ser iguais). O valor é sempre tratado como DECLARADO; a parcela nasce `receipt_claimed`.
- Rótulos: "Comprovante conferido (não é recebimento)" (C1) e, no detalhe do contrato, "Recebimento declarado / Confirmado pelo gateway / Conciliado com o extrato" ao lado de cada parcela com valor pago.
- Política de comissão (F1 consome): `requiredEvidence` com padrão `receipt_claimed` (`requiredEvidenceOf`, `evidenceSatisfies` em `server/settlementEvidence.ts`). Nada é bloqueado agora.

## Conciliação (vínculo explícito)
- `financial_transactions.installmentId` (migração 0075) é gravado pela baixa manual e pelo webhook. `reconcileEntry` promove a `bank_reconciled` SOMENTE a parcela vinculada e só para lançamento de entrada (income). Sem vínculo (ex.: entrada informada pelo Sales), despesa ou estorno: não promove e audita (`reconcile_installments_skipped`). Nunca se infere por contrato+valor.
- A evidência só sobe: webhook tardio não rebaixa `bank_reconciled`.

## Contrato (aditivo, só com flag; Suite #130 aceita `settlementEvidence` opcional)
- Com `INSTALLMENT_EVIDENCE_IN_EVENT=true`: `installment.paid` leva `settlementEvidence`; `financial.entry.reconciled` leva `installmentIds` e `settlementEvidence` quando houve promoção. NOVO para o Financial/Suite: `installmentIds` em `financial.entry.reconciled` (a Suite precisa aceitar antes de ligar a flag).
- Os campos NÃO entram em `allowedPayloadFields` nem no snapshot: são acrescentados pelo filtro só com a flag. Snapshot e `consumers.lock.json` ficam intactos neste PR; o PR de re-pin (depois do #130 mergeado) os promove à lista estática.

## Migração proposta 0075 (nada aplicado)
Rollback `docs/rollback/0075_installment_settlement_evidence.down.sql` (apaga a coluna; desligar a flag antes), sobe-desce-sobe testado em MySQL descartável.

## Testes
`server/settlementEvidence.test.ts` (ordem, requiredEvidence, soma exata, alias do Sales) e `server/settlementEvidence.mysql.test.ts` (baixa manual, flag no evento, webhook, conciliação exata e ambígua).
