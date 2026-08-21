# Torre de Comando TGR — Matriz de Dados, Filtros e Drill-Down

## Princípio de operação

Um dashboard só entra no TGR se responder a três coisas: **o que desviou**, **por que desviou** e **quem age agora**. O número não termina no gráfico; ele abre a lista filtrada e o registro operacional correspondente.

## Filtros globais governados

| Dimensão | Aplicação |
|---|---|
| Período e granularidade | dia, semana, mês, trimestre, coorte e comparação com período anterior |
| Empreendimento e produto | empreendimento, unidade/cota, produto, fração, status de inventário |
| Aquisição e sala | campanha, canal, origem, promotor, sala, mesa, turno, liner, fechador/FTB |
| Comercial | equipe, vendedor, etapa, faixa de VGV, desconto, idade da oportunidade |
| Financeiro | entrada, vencimento, faixa de atraso, forma de pagamento, status, renegociação e cobrança |
| Carteira e experiência | coorte de venda, contrato, ativação, reserva, uso, manutenção, chamado e distrato |
| Governança | responsável, perfil, status de aprovação, motivo, evento e qualidade do dado |

## Cruzamentos prioritários

| Pergunta da diretoria | Medida | Corte obrigatório | Drill-down |
|---|---|---|---|
| Qual canal traz venda saudável? | CAC, custo por chegada/tour/venda, entrada recebida, distrato | canal, campanha, empreendimento, coorte | captações → oportunidades → contratos → parcelas/distratos |
| Onde a sala está vazando? | espera, no-tour, tour, proposta, contrato | sala, turno, mesa, promotor, liner, fechador | fila de captação e histórico do atendimento |
| VGV virou caixa? | contratado, entrada prevista, entrada recebida, aging | empreendimento, vendedor, campanha, coorte | contratos → parcelas → contatos de cobrança |
| Quem vende com qualidade? | VGV, recebimento, distrato, inadimplência inicial, comissão | equipe, papel, produto, período | oportunidades/contratos e borderô |
| Qual carteira exige intervenção? | atraso, promessa quebrada, contato, uso, chamados, pedido de distrato | coorte, empreendimento, risco, responsável | ficha 360° do associado e contrato |
| Onde a operação não entrega? | disponibilidade, bloqueios, manutenção, espera, reservas falhas | empreendimento, unidade, período, status | unidade, manutenção, reserva e lista de espera |

## Painéis e alertas de exceção

O painel operacional existente já reúne parcelas vencidas, follow-ups atrasados, manutenção e ofertas de espera expiradas. A evolução deve acrescentar exceções de captação sem desfecho, proposta sem próximo passo, contrato sem assinatura, entrada prevista não recebida, comissão sem conciliação, distrato aguardando decisão, direito de uso não ativado e integração sem reconciliação.
