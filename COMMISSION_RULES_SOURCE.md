# Fonte de Regras — Comissão Proporcional

As regras enviadas pelo negócio em `lib-comissoes.ts` e `lib-datasComissao.ts` foram registradas como referência de produto para implementação independente no TGR-CRM.

| Regra | Definição de origem |
|---|---|
| Papel comercial | Linear: 1,91%; fechador: 1,51%; FTB: 3,42%. |
| Base de comissão | Saldo-base da venda, após a entrada de corretagem, quando aplicável. |
| Liberação | Cada pagamento da entrada libera comissão proporcional à sua participação na entrada total. |
| Fechamento não-crédito | PIX, débito, boleto compensado, espécie, cheque e outros fecham no último dia do mês da compensação. |
| Fechamento no crédito | Fecha no último dia do mês seguinte à compensação. |
| Cancelamento | Janela até o dia 7 do mês posterior ao fechamento. |
| Pagamento previsto | Dia 25 do mês posterior ao fechamento. |

Essas regras serão modeladas como domínio próprio, testável e auditável. A fonte é um artefato operacional enviado pelo usuário; nenhuma implementação externa será copiada para o produto.

## Estados e borderô

O ciclo de uma parcela de comissão precisa distinguir: prevista, aguardando pagamento do cliente, em fechamento, aguardando janela de cancelamento, a receber, recebida, cancelada sem pagamento e atrasada. A prioridade é terminal: recebimento real vence qualquer outro estado; falta de compensação do cliente mantém a parcela travada; cancelamento dentro da janela cancela o pagamento.

O borderô mensal deve agrupar pelo mês do pagamento previsto e expor os totais de previsto, a receber, recebido, travado, cancelado e atrasado, além da quantidade de parcelas. Essa será a especificação funcional para o read model executivo do TGR-CRM.
