# ETAPA 2 · F2 · Calendário de pagamento da comissão (payoutSchedule)

Status: proposta, DORMENTE. Sem migração (campo dentro do JSON da política). `COMMISSION_V2_RELEASED` intocada; nenhuma comissão positiva é liberada por este PR.

- `commissionPolicy.payoutSchedule = { mode: "full_upfront" | "per_installment" }` (estrito, editável nas telas de política/versão). Ausente = `full_upfront` (padrão da empresa, "pago integral à vista"), configurável.
- `full_upfront`: uma comissão por papel/contrato, no valor TOTAL do motor V2 (menos o já liberado, nunca passa), na primeira parcela elegível paga (confirmação do recebimento da entrada). As parcelas seguintes não geram linha. `per_installment` mantém o proporcional histórico.
- Dormente: só o motor V2 lê o campo, e o V2 segue travado. O V1 (taxas por papel, hoje 0%) não muda. Com o V2 travado, `full_upfront` não gera nada (teste).
- Testes que prendiam o proporcional como padrão do V2 (`commissionV2.mysql`) passaram a declarar `per_installment` explicitamente; novos testes cobrem o padrão `full_upfront`, o dormente e a função pura.
- Eventos/contrato: nenhum.

## Elegibilidade da baixa (Codex P1)
O V2 (liberado) só dispara numa baixa ELEGÍVEL da ENTRADA: método da baixa dentro de `eligiblePaymentMethods` e parcela do cronograma de entrada (acumulado em ordem de sequência cabe no valor de entrada da proposta, `isEntryInstallment`). Baixar o saldo primeiro ou usar método inelegível segura a comissão até uma baixa elegível da entrada. Nota: o V1 não confere `eligiblePaymentMethods` (taxas 0%, sem efeito hoje); fica fora deste PR.
