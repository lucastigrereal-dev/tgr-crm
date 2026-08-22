# TGR-CRM — Síntese de Deep Research UI/UX

**Escopo.** Esta síntese consolida cinquenta frentes independentes de pesquisa sobre CRM, RevOps, finanças, ERPs, operação de hospitalidade, sala de supervisão, comissão, acessibilidade e design systems. A base bruta está preservada em `/home/ubuntu/tgr_uiux_deep_research_50.csv` e `/home/ubuntu/tgr_uiux_deep_research_50.json`. O objetivo não é copiar aparência: é transformar a interface do TGR em uma **superfície de decisão operacional**, onde cada pessoa vê contexto, risco, próximo passo e consequência.

> **Tese visual do TGR:** o produto deve combinar a legibilidade de um CRM moderno, a evidência de uma plataforma financeira e a urgência controlada de uma sala operacional. Não é um ERP cinza, nem um painel de TV com card colorido.

## Decisões que a pesquisa tornou obrigatórias

| Decisão | Padrão observado | Aplicação no TGR | Risco que evitamos |
|---|---|---|---|
| Navegação por papel e tarefa | SAP Fiori e NetSuite organizam centros de trabalho por função e responsabilidade. [1] [2] | Sidebar passa a agrupar **Operar**, **Vender**, **Receber** e **Governar**, com contexto da página no topo. | Menu longo sem prioridade operacional. |
| Três camadas de decisão | Clari, Palantir e Stripe separam resumo, investigação e ação. [3] [4] [5] | Toda tela crítica terá: pulso executivo, lista investigável e ação protegida. | Dashboard que mostra problema mas não permite resolver. |
| Registro como hub | HubSpot, Salesforce e Notion usam registro com timeline, propriedades e ações no mesmo contexto. [6] [7] [8] | Associado, contrato e oportunidade mantêm cabeçalho fixo, estado, evidência e próximas ações. | Espalhar a história do cliente em cinco páginas. |
| Fila antes de card | ServiceNow, Toast e Genesys priorizam listas de itens ativos e estados de trabalho. [9] [10] [11] | Sala de Vendas e exceções operacionais usam fila com dono, tempo, estado e ação primária. | “Central de comando” virar árvore de Natal de KPI. |
| Tabela densa e limpa | Airtable, Retool e Carbon preservam densidade com ações por linha, filtros e hierarquia. [12] [13] [14] | Listas do TGR usam colunas essenciais, ações contextuais, sticky header e detalhes por expansão. | Card demais e nenhuma comparação real. |
| Visões são lentes, não cópias | Airtable, HubSpot e Jira tratam view salva como consulta persistente e compartilhável. [12] [15] [16] | Recortes salvos do TGR devem ter nome, público, filtros expostos e origem auditável. | Filtro escondido ou relatório impossível de reproduzir. |
| Estado financeiro é uma trilha | Stripe, Modern Treasury e Asaas apresentam cobrança/pagamento como estados e eventos. [5] [17] [18] | Ledger do TGR aparece por contrato como fatos, regra aplicada, origem e reversão. | Chamar valor previsto de caixa. |
| Exceção exige evidência e dono | PagerDuty, Jira Service Management e ServiceNow vinculam severidade, prazo e rota. [19] [20] [9] | Alertas TGR sempre mostram por que apareceu, quem resolve e para onde ir. | Alarme vermelho sem ação e sem responsável. |
| Ranking só vale por função | Salesforce e HubSpot distinguem quota, atividade e desempenho por papel. [21] [22] | Captador, qualificador, liner, fechador/FTB, gerente e carteira financeira são comparados dentro do próprio papel. | Colocar vendedor e financeiro na mesma corrida idiota. |
| Meta precisa de qualidade | Sistemas de forecast combinam objetivo, ritmo, cobertura e risco, não só resultado bruto. [3] [22] | Meta TGR usa VGV líquido, caixa confirmado, sobrevivência e qualidade de documentação. | Premi ar venda podre e distrato futuro. |
| Mobile é outra experiência | Material Adaptive e Salesforce datatable evidenciam que tabela densa não deve apenas encolher. [23] [24] | No celular: fila priorizada, ações rápidas, cards de contexto e drill-down; nunca a tabela inteira comprimida. | Painel ilegível no telefone do gerente. |
| Acessibilidade é requisito operacional | WCAG 2.2 exige contraste, foco visível e que cor não seja único sinal. [25] | Cor sempre vem com texto/ícone, foco de teclado e status explícito. | Gerente não enxergar estado crítico ou navegação impossível. |

## Sistema visual recomendado: “Luxury Operations, sem frescura”

O TGR deve preservar sua assinatura verde-profundo, dourado e marfim, mas reduzir o excesso de arredondamento e transformar o dourado em **cor de decisão positiva/ação principal**, não em enfeite em todo canto. A sidebar é escura e silenciosa; a área de trabalho é clara e extremamente legível. A cor semântica deve ter papel fixo: verde para saudável/confirmado, âmbar para atenção/em risco, vermelho para bloqueio/crítico e azul-petróleo para informação/rastreabilidade. Status nunca dependem apenas de cor. [25]

| Elemento | Regra visual |
|---|---|
| Tipografia | Serif apenas para título de contexto e momentos executivos; sans para operação, tabela e número. Títulos mais curtos, labels claros, números com tabulação. |
| Espaçamento | Grade de 8 px; páginas em blocos operacionais largos, sem mosaico de cartões minúsculos. |
| Cards | Apenas para decisão, métrica ou ação. Tabela, fila e timeline não viram card. |
| Tabelas | Cabeçalho sticky, hierarquia por peso e alinhamento numérico, ação por linha no fim, filtro visível. |
| Alertas | Severidade curta: atenção, crítico e bloqueio. Todo alerta tem evidência, dono, prazo e CTA. |
| Motion | Apenas feedback de abertura, sucesso e troca de estado; nunca animação decorativa que atrasa sala de vendas. |

## Ordem de redesenho: primeira onda

1. **Shell e navegação.** Reorganizar sidebar por intenção de trabalho, criar command bar contextual, reduzir ruído e melhorar o topo mobile.
2. **Torre de Comando.** Transformar o topo em “pulso + exceção + fila de decisão”; filtros e recortes salvos passam a ser primeira classe, não rodapé de formulário.
3. **Central de Comissões.** Mostrar ranking por papel, qualidade de receita, explicação de cálculo, carteira financeira e ações de contestação/rota.
4. **Sala de Vendas.** Priorizar fila viva, relógio, papel atribuído, atraso e ação de gerente; nenhum card ornamental compete com a operação.
5. **Ficha de Contrato.** Cabeçalho de estado, ledger econômico, documentos, carteira, distrato e timeline em uma sequência progressiva de decisão.

## Vinte mecânicas que melhoram meta, ritmo e motivação sem premiar cagada

1. Progresso diário contra meta de **VGV líquido**, não apenas VGV assinado.
2. Forecast semanal por papel com faixa provável e lacuna até a meta.
3. Ritmo de captação, qualificação, tour e fechamento separado por função.
4. Semáforo de dois/três dias sem evento relevante, com sugestão de ação ao gerente.
5. Ranking por papel e janela temporal, nunca placar único da operação inteira.
6. Comparação do profissional contra sua própria média móvel, não apenas contra o campeão.
7. Sinal de venda que entrou mas perdeu qualidade documental.
8. Sinal de desconto acima do padrão da sala/campanha, com aprovação exigida.
9. Comissão esperada versus comissão efetivamente liberada, por ciclo.
10. “Carteira saudável” por financeiro: aberto, atraso, recuperado e regularização após posse.
11. Recompensa visual por recuperação de caso crítico, sem expor cliente ou humilhar colega.
12. Meta de equipe conectada à contribuição individual explicável.
13. Medidor de cobertura de pipeline/captação para não esperar o mês morrer.
14. Quadro do gerente com exceções por urgência e pessoa responsável.
15. Destaque de evolução de qualidade: menos distrato, melhor documentação, melhor entrada confirmada.
16. Comparativo de salas por conversão e tempo de ciclo, com filtro de campanha/empreendimento.
17. Streak saudável baseado em atividades válidas e qualidade, não em clique.
18. “Próxima melhor ação” baseada em evidência, não em recomendação mística de IA.
19. Visões salvas como rituais: reunião de manhã, pulso de sala, cobrança da tarde e fechamento semanal.
20. Timeline de reconhecimento auditável: resultado, contexto e critério pelo qual o profissional foi destacado.

## O que o TGR não vai copiar

O produto não vai copiar dark patterns de gamificação, ranking que humilha, badgezinho infantil, card excessivo, vermelho para qualquer coisa, animação em tarefa urgente, gráfico sem drill-down, métrica sem definição, alerta sem dono, ou meta que incentive contrato ruim. A pesquisa de incentivos alerta que métricas isoladas são suscetíveis a manipulação e comportamento de gaming; a interface deve premiar resultado que persiste, não apenas volume de curto prazo. [26] [27]

## Protocolo obrigatório de futuras waves

Toda wave do TGR deve começar com: **(1)** deep research por benchmark/risco, **(2)** fontes verificáveis preservadas, **(3)** decisão de produto registrada, **(4)** especificação técnica/testável, **(5)** implementação, **(6)** validação visual e funcional, e **(7)** checkpoint. A pesquisa não substitui decisão; ela impede que a decisão seja chute.

## Referências

[1]: https://www.sap.com/design-system/fiori-design-web/v1-96/discover/sap-products/sap-s4hana-only/best-practices-for-designing-sap-fiori-apps
[2]: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2890160.html
[3]: https://www.clari.com/products/forecast/
[4]: https://palantir.com/docs/foundry/app-building/operational-apps/
[5]: https://docs.stripe.com/dashboard/basics
[6]: https://knowledge.hubspot.com/records/work-with-records
[7]: https://trailhead.salesforce.com/content/learn/modules/lightning_app_builder/lightning_app_builder_recordpage
[8]: https://www.notion.com/help/intro-to-databases
[9]: https://www.servicenow.com/docs/r/yokohama/servicenow-platform/advanced-work-assignment/awa-queues.html
[10]: https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens
[11]: https://help.genesys.cloud/articles/about-real-time-supervision/
[12]: https://support.airtable.com/articles/5189551686-getting-started-with-airtable-views
[13]: https://docs.retool.com/education/coe/well-architected/design
[14]: https://carbondesignsystem.com/components/data-table/usage/
[15]: https://knowledge.hubspot.com/records/create-and-manage-saved-views
[16]: https://support.atlassian.com/jira-software-cloud/docs/manage-filters/
[17]: https://www.moderntreasury.com/products/ledgers
[18]: https://docs.asaas.com/docs/cobrancas-via-pix
[19]: https://support.pagerduty.com/main/docs/incident-priority
[20]: https://support.atlassian.com/jira-service-management-cloud/docs/what-is-the-incident-timeline/
[21]: https://www.salesforce.com/blog/sales/sales-leaderboard/
[22]: https://knowledge.hubspot.com/forecast/use-the-forecast-tool
[23]: https://m3.material.io/foundations/adaptive-design/overview
[24]: https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-datatable.html
[25]: https://www.w3.org/TR/WCAG22/
[26]: https://www.cna.org/analyses/2022/09/goodharts-law
[27]: https://www.journals.uchicago.edu/doi/abs/10.1086/673371
