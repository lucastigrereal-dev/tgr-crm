# Cobertura real dos scorecards profissionais

| Papel | Fonte transacional atual | Situação no TGR | Regra de crédito |
| --- | --- | --- | --- |
| Captador | `capture_records.promoterId` | Ativo | Recebe crédito pela venda ligada à ficha mais recente da oportunidade. |
| Liner | `capture_records.linerId` | Ativo | Recebe crédito quando não é FTB. |
| Fechador | `capture_records.closerId` | Ativo | Recebe crédito quando não é FTB. |
| FTB | `linerId = closerId` | Ativo | Recebe um único crédito FTB; não soma liner + fechador. O captador continua creditado. |
| Qualificador | `capture_records.qualifierId` | Ativo | Recebe crédito somente quando a qualificação está concluída e a ficha está vinculada ao resultado. |
| Gerente de sala | `capture_records.roomManagerId` | Ativo | Recebe crédito por atribuição explícita de mesa; nunca por inferência do usuário que alterou estado. |
| Financeiro | `financial_portfolio_assignments.ownerUserId` | Ativo | Recuperação só conta após o início da atribuição da carteira; criador de baixa não recebe crédito automático. |

## Decisão de governança

> O TGR não transforma ausência de atribuição em resultado profissional. Cada novo papel só entra no scorecard quando possuir: identidade persistida, momento de atribuição, evento de troca e regra de crédito aprovada.

## Próxima migração segura

A próxima evolução de scorecard deve ampliar os filtros de contexto (empreendimento, sala, campanha e coorte) e tornar metas por papel configuráveis. A atribuição de `qualifierId`, `roomManagerId` e dono de carteira financeira já está persistida, auditada e usada na leitura atual.
