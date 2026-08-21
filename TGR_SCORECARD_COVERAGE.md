# Cobertura real dos scorecards profissionais

| Papel | Fonte transacional atual | Situação no TGR | Regra de crédito |
| --- | --- | --- | --- |
| Captador | `capture_records.promoterId` | Ativo | Recebe crédito pela venda ligada à ficha mais recente da oportunidade. |
| Liner | `capture_records.linerId` | Ativo | Recebe crédito quando não é FTB. |
| Fechador | `capture_records.closerId` | Ativo | Recebe crédito quando não é FTB. |
| FTB | `linerId = closerId` | Ativo | Recebe um único crédito FTB; não soma liner + fechador. O captador continua creditado. |
| Qualificador | Não há identificador próprio persistido | **Não instrumentado** | Não gerar ranking até existir atribuição explícita. |
| Gerente de sala | Não há identificador próprio persistido | **Não instrumentado** | Não inferir gerente pela sala ou por usuário que apenas alterou estado. |
| Financeiro | Há criador de lançamento, mas não dono de carteira/contrato | Parcial | Não usar `createdByUserId` como “responsável financeiro” sem regra de operação. |

## Decisão de governança

> O TGR não transforma ausência de atribuição em resultado profissional. Cada novo papel só entra no scorecard quando possuir: identidade persistida, momento de atribuição, evento de troca e regra de crédito aprovada.

## Próxima migração segura

A próxima evolução de scorecard deve acrescentar, à ficha de captação, `qualifierId` e `roomManagerId`, com trilha de auditoria em cada alteração. Para financeiro, o modelo deve declarar um **dono de carteira** no contrato ou parcela; o usuário que lançou uma baixa é operador, não necessariamente responsável pelo relacionamento de cobrança.
