# Regras de comissão V2 (dado configurável, nasce travado)

Motor puro em `shared/commissionRulesV2.ts` (valores em centavos e pontos-base, sem float). Por papel (captador, consultor, fechador): valor fixo por cota, percentual sobre a entrada efetiva ou faixa por valor da entrada, com desconto da taxa da maquininha.

- **Nada paga sozinho.** Nenhum motor de pagamento lê esta regra até o admin do sistema liberar a política (ADR-010: padrão 0%, nada é inventado). Ligar o motor à geração de comissão por parcela é o passo seguinte, só depois da liberação.
- **Rascunho da Five** (`FIVE_COMMISSION_DRAFT_V2`, ditado do Lucas em 19/10/2026): comercializadora 16,5% sobre a venda; fechador 15% da entrada efetiva acima de R$ 3.990, senão 10%; consultor 10% da entrada efetiva; captador R$ 400 por cota; taxa da maquininha configurável.
- **Confirmado pelo Lucas (19/10/2026 15:21Z):** R$ 3.990 exato já paga 15% ao fechador; abaixo disso 10%; consultor 10%; captador R$ 400 por cota; tudo sobre o líquido (entrada menos a taxa da maquininha), inclusive a comparação com R$ 3.990. Cada ponto é um campo da regra (`strictlyAbove`, `tierBase`, `deductMachineFee`), então mudar é dado, não código.
