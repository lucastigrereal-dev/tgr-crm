# Ficha do captador v2 no CRM (26/10)

Estado: **atrás de `CAPTURE_FICHA_V2_ENABLED=false`**. A migration **0091** é PROPOSTA (não aplicada). SEM CI DO GITHUB. Dados de teste sintéticos. Rascunho NÃO vem para o CRM (o GuestPass só envia ficha finalizada).

| Pedido da v2 (GuestPass) | Onde fica no CRM |
|---|---|
| `visitType` tour_direto / agendamento | `captures.create` recebe `visitMode`; guardado em `capture_ficha_v2.visitMode` (0091) |
| `titularAge` | `holderAge` (0–120), em `capture_ficha_v2.holderAge`; idade do cônjuge segue `partnerAge` |
| `phone2` (telefone da mulher) | `partnerPhone` vira contato do associado (`customer_contacts`, rótulo "Telefone do cônjuge"); igual ao principal ou repetido não duplica |
| `carModel` em campo único | já cabe: `vehicleModel` sem `vehicleBrand` (marca é opcional) |
| CPF | continua opcional na captação; obrigatório só na recepção (fora deste PR) |

## Tour direto: como não quebra painéis nem alertas
Tour direto = visita **de hoje, sem horário**. O CRM **não grava `scheduledAt`** e **não marca passante**: a ficha nasce `captured`, sem tarefa de agendamento (nenhum alerta de horário) e entra na fila do dia pela data de criação, que é como a fila já lê ficha sem data. Passante e tour direto ficam distinguíveis depois pelo `visitMode`. Na regra `CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY`, tour direto vale como visita explícita. Tour direto com horário, ou também passante, é recusado. Agendamento exige `scheduledAt` (data e horário).

## Flag desligada
Qualquer campo novo (`visitMode`, `holderAge`, `partnerPhone`) é **recusado** (PRECONDITION_FAILED), nunca descartado em silêncio. Ficha sem campo novo segue idêntica. A fila offline usa o mesmo schema; o reenvio com o mesmo `clientRequestId` continua devolvendo a mesma ficha.

## Exclusão (LGPD)
`applyCustomerAnonymization` (pedido de exclusão e exclusão propagada) zera `holderAge` das fichas apagadas e já apagava os contatos (2º telefone). Roda mesmo com a flag desligada depois; sem a 0091 aplicada a tabela não existe (errno 1146) e não há o que apagar.

## Não coberto
Tela (`Capture.tsx`) ainda não tem os campos novos; o contrato `guestpass.prefill.v1` (Suite primeiro) não mudou. Para ligar: aplicar a 0091 (GO do dono do banco, com backup), depois a flag.
