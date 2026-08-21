# Política de Responsabilidade da Torre de Comando

## Princípio

Uma exceção só pode apontar uma **pessoa** quando o vínculo estiver persistido no registro de origem. Enquanto o vínculo individual não existir, a torre deve apontar o **papel responsável**, sem inferir culpa por proximidade de módulo.

| Desvio | Papel responsável inicial | Prazo operacional | Fonte de verdade |
|---|---|---:|---|
| Captação sem desfecho | Comercial / recepção | 24 horas | ficha de captação e status de apresentação |
| Proposta sem próximo passo | Vendedor da oportunidade | data do follow-up | oportunidade e agenda |
| Entrada ou parcela vencida | Financeiro | vencimento da parcela | contrato e parcela |
| Comissão sem conciliação | Financeiro / comissões | pagamento previsto | borderô de comissão |
| Distrato aguardando decisão | Administração / financeiro | política do empreendimento | solicitação de distrato |
| Reserva, manutenção ou espera | Atendimento / operações | prazo do evento | reserva, manutenção e lista de espera |

## Regra de evolução

O próximo contrato de dados deve incluir `responsibleUserId` e `actionDueAt` nos desvios que ainda não os possuem. Isso permite a atribuição individual auditável sem substituir as regras de acesso já centralizadas em `server/routers/access.ts`.
