# Tabela de verdade dos estados da sala (M-A01-01 / M-A01-04)

Estado: provado no container (SEM CI DO GITHUB). Fonte: `server/officialIndicators.ts`, `server/routers/officialIndicators.ts`, `drizzle/schema.ts` (`capture_records`).

Duas dimensões, nunca misturadas:

- **Chegada (modalidade)**: agendada (`scheduledAt`) ou passante (`isPasserby`, tour direto de campo). Gravada na ficha e preservada quando o resultado é registrado.
- **Resultado**: VENDEU / CAIU EM MESA (`commercialOutcome`), NT de perfil, tempo ou consultor (`ntKind`, motivo padronizado), tour sem venda (ficha encerrada), em andamento.

| Estado | Entra no denominador (iniciados)? | Entra no numerador? | Observação |
|---|---|---|---|
| Agendado sem check-in (não comparecimento) | não | não | Sem check-in não há atendimento iniciado |
| Check-in, em andamento (sem desfecho) | não (decisão do Lucas, 25/10) | não | Entra no denominador quando tiver desfecho; admin pode incluí-lo (configurável) |
| NT (perfil / tempo / consultor) | sim | não | Conta à parte (`outcomes.naoTour`); não é não venda |
| Tour feito, ficha encerrada sem venda | sim | não | `outcomes.encerradoSemVenda` |
| CAIU EM MESA | sim | não | Não é venda; supera VENDEU; fração só volta no distrato executado |
| VENDEU (resultado da sala) | sim | não por si | Resultado de sala não é venda validada |
| Venda validada pelo CRM (contrato não cancelado) | sim | sim | Numerador = `sale_validations.validatedAt` |
| Contrato cancelado / distratado | n/a | sai do numerador | Cotas voltam só no distrato executado |

Numerador e cotas: 5 VENDEU de sala podem ser 8 cotas; vendas = contratos validados, nunca cotas nem resultados de sala.
Período e fuso: dia civil do check-in no fuso do projeto (`FINANCIAL_PROJECT_TIMEZONE`, padrão America/Recife; sem horário de verão, igual a America/Fortaleza). Resposta traz `cohort` (por início do atendimento) e as colunas por data da validação lado a lado.
