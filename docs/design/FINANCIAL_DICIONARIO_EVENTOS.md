# Dicionário financeiro do CRM (M-A08-01)

Estado: provado no container contra o código do CRM (SEM CI DO GITHUB). O lado do Financial (apps/financial-layer, repositório da Suite) é dono do próprio razão: aqui só consta o que o CRM emite. NÃO VERIFICADO no Financial.

| Termo | O que é no CRM | Dono do fato | Evento / registro | Correção auditável |
|---|---|---|---|---|
| Previsto | Parcela criada e aberta (`installments.status = open`) | CRM | `installment.scheduled` | Renegociação gera `installment.renegotiation.applied`; a original fecha como renegociada |
| Comprovante | `sale_validations.paymentConfirmedAt` + nota + referência opaca | Administrativo autorizado | audit `payment_confirmed` | Não liquida: parcela segue aberta, sem lançamento, sem `installment.paid` |
| Conferido | Comprovante + documentação conferidos (`documentsConferredAt`) | Administrativo autorizado | audit | Só libera a validação da venda |
| Recebido / liquidado | Baixa da parcela (`paid`, `paidAmount`) com lançamento em `financial_transactions` | CRM (financeiro) ou webhook do gateway | `installment.paid` | Uma baixa por parcela; repetir devolve `alreadyPaid` |
| Conciliado | Lançamento conciliado com o extrato | Financial | `financial.entry.reconciled` | Evento próprio; não reabre a parcela |
| Disponível | Saldo liberado para repasse/comissão | Financial | `financial.transfer.*` | Fora do CRM |
| Comissão | Linha em `sales_commissions` gerada pela baixa | CRM | `commission.created` | Nunca estorno automático; ajuste manual auditado |

## Idempotência (chave natural, não só eventId)

- `installment.paid` usa `installment-paid:<parcelaId>`; `commission.created` usa `commission-created:<comissãoId>`; `commission.automatic.blocked` usa `commission-blocked:<parcela>:<motivo>:<origem>`. Reprocessar os fatos, repetir a baixa ou receber o webhook de novo grava `domain_events` uma vez só (insert com chave única).
- A entrega ao Financial carimba recibo `financial-event:<eventId>` em `audit_logs`; evento com recibo não é reenviado.
- Um eventId novo para o mesmo fato (parcela + tipo) não nasce: a chave natural impede o segundo evento. Quem consome no Financial deve repetir a mesma garantia (NÃO VERIFICADO lá).

## Prova

`server/installmentSettlementOutbox.mysql.test.ts`: comprovante não liquida; 4 baixas simultâneas = 1 lançamento e 1 evento; reprocesso dos fatos 3× não duplica.

## Comissão: versão da política, centavos e vigência (M-A08-02, D2=B)

- **Quem calcula:** o CRM. O Financial só registra `commission.created` como recebido e não recalcula nada.
- **Qual versão vale:** a política em vigor na data do VENDEU (`commissionPolicyAnchor`: `commercialOutcomeAt` da ficha; sem VENDEU, a criação do contrato). Não é a data da parcela paga, nem a da validação, nem `now`. Isso vale também para o cancelamento de comissão já paga.
- **Pagamento:** a versão não autoriza pagar. Segue exigindo validação oficial do adm e entrada inteira.
- **Payload:** `commission.created` ganhou o campo OPCIONAL `policyVersion` (código da versão, ou `"legacy"` para a configuração antiga do empreendimento). Comissão manual não envia o campo. Quem ignora campos desconhecidos continua funcionando.
- **Centavos:** o valor é calculado e arredondado em centavos inteiros, metade para cima (`toCents`, com `toPrecision(15)` para tirar o ruído de float: `1.005` vira 1,01). O payload sempre traz `amount` com no máximo 2 casas.
- **Vigência:** uma versão de comissão nunca é editada (só aposentada). Uma versão nova tem de começar DEPOIS de toda versão de comissão ainda aberta do empreendimento; empate ou data anterior é recusado (`CONFLICT`). A vigência retroativa continua recusada.
- **Taxas:** vêm só da política versionada do empreendimento (padrão 0%, sem taxa fixa no código). O 16,5% da comercializadora (Five) é configuração a ratificar e não gera lançamento.
