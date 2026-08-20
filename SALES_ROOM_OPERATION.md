# Sala de Vendas — Contrato Operacional

A Central de Sala de Vendas mantém a fila operacional do dia por consulta automática a cada **5 segundos**, além do botão de atualização manual. A escolha deliberada é de consulta curta, sem serviço persistente adicional, adequada ao ambiente atual e com custo operacional nulo.

| Etapa | Estado persistido | Regra operacional |
|---|---|---|
| Aguardando | `scheduled` | Ficha com data/hora, aguardando chegada. |
| Chegou | `checked_in` | Recepção confirmou presença; mesa e time podem ser atribuídos. |
| Em apresentação | `presented` | Exige check-in e mesa; cronômetro é iniciado. |
| Encerrada | `closed` | Registra hora final e duração; sai da fila ativa, preservando histórico auditável. |
| Sem-tour | `no_tour` | Exige motivo; encerra a ficha sem iniciar apresentação. |

Cada transição registra auditoria e evento de domínio com payload permitido. O status `closed` indica que a apresentação foi concluída; o resultado comercial final continua no fluxo de oportunidade e proposta, evitando que a recepção invente uma venda onde não houve uma.
