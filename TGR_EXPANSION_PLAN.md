# TGR-CRM — Plano de Expansão Executável

**Atualizado em:** 22 de agosto de 2026  
**Marco-base:** checkpoint `f17d271` e sincronização no GitHub privado `lucastigrereal-dev/tgr-crm`  
**Regra-mãe:** o TGR não expande por catálogo de ideias. Cada onda só avança quando há evidência, responsabilidade, teste e uma decisão operacional que alguém consegue tomar melhor.

> **Tese:** o TGR-CRM deve operar como o sistema nervoso da Tigre Digital Group: registra o fato na origem, preserva a trilha, identifica risco, atribui um responsável e entrega a próxima ação. Não é um ERP cinza com ouro em cima, nem um painel de televisão cheio de bolinha colorida.

## Estado real de partida

O produto já possui domínio operacional relevante: associados, captação online/offline, sala de vendas, oportunidades, contratos, parcelas, documentos, reservas, campanhas, playbooks, importação reversível, comissões por papel, filtros salvos, carteira financeira, política comercial por empreendimento e ledger idempotente de qualidade da receita. A primeira onda de UI/UX consolidou shell, Torre de Comando, Central de Comissões, Sala de Vendas e ficha contratual com testes, build e revisão visual nos estados disponíveis.

O que **não** será vendido como pronto é igualmente importante: a prova visual preenchida de contrato/distrato depende do laboratório isolado; a recepção ainda usa polling de cinco segundos e não realtime estrito; PIX/boleto exige credenciais reais do Asaas; e toda IA continua condicionada à qualidade, permissão e rastreabilidade dos dados.

| Ativo entregue | Uso operacional atual | Limite honesto |
|---|---|---|
| Ledger econômico | Explica VGV, caixa, exposição, comissão e reversão por contrato. | Precisa de cenários isolados preenchidos para demonstração visual completa. |
| Sala de vendas | Controla fila, chegada, mesa, papéis, tour e sem-tour. | Atualiza por polling; SSE/WebSocket requer arquitetura always-on. |
| Torre e scorecards | Reúne métricas, exceções, ritmo, ranking por papel e filtros compartilháveis. | Mobile ainda precisa de comando compacto e densidade superior. |
| Contrato e distrato | Mantém documento, carteira, parcelas, simulação e aprovação protegida. | A demonstração preenchida não deve contaminar a base operacional. |
| Cobrança digital | Preparada na arquitetura. | Emissão só entra após credencial Asaas e validação de ambiente. |

## Princípios de priorização

As ondas seguem a lógica observada em plataformas de operação: primeiro garantir **contexto, investigação e ação**; depois aumentar a transparência econômica; por fim automatizar e aplicar inteligência. CRM e finance ops maduros separam resumo, investigação e ação no mesmo fluxo [1] [2] [3]. Fila de trabalho, e não mosaico de métricas, deve conduzir itens vivos [4] [5]. Dados financeiros precisam ser expostos como eventos e estados rastreáveis, e não como número solto [3] [6].

| Critério | Pergunta de corte | Regra de decisão |
|---|---|---|
| Impacto de caixa | Isso diminui venda podre, atraso, distrato ou comissão sem lastro? | Prioridade alta se toca dinheiro e decisão humana. |
| Frequência | A pessoa usa todo dia ou só em reunião? | Operação diária vence relatório bonito de fim de mês. |
| Evidência | O fato tem fonte, dono, prazo e regra aplicada? | Sem evidência, não há alerta nem recomendação. |
| Dependência | Precisa de credencial, infraestrutura persistente ou dado externo? | Não travar o núcleo por integração que ainda não existe. |
| Demonstração segura | Dá para provar sem inventar dado no banco operacional? | Usar laboratório isolado ou manter fronteira documentada. |

## Roadmap por ondas

| Ordem | Onda | Resultado de produto | Dependências | Critério de aceite |
|---:|---|---|---|---|
| 1 | **Concluída — Casca operacional** | Shell premium, Torre, Comissões, Sala e Contrato com hierarquia e design tokens coerentes. | Pesquisa UI/UX e componentes compartilhados. | `pnpm check`, 144 testes, build e revisão desktop/mobile dos estados disponíveis. |
| 2 | **Experiência de decisão móvel** | Command bar, filtros compactos e tabelas/listas densas para Torre, Comercial, Financeiro e Comissões. | Deep research específico de comandos, filtros e data grids; inventário dos componentes existentes. | Filtros aplicáveis sem rolagem excessiva; tabela vira lista priorizada no celular; foco e teclado verificados. |
| 3 | **Transparência econômica acionável** | Fila financeira por risco, explicação de exceções e ações rastreáveis por contrato, carteira, campanha e responsável. | Contrato de dados do ledger, scorecards e regras de cobrança já existentes. | Toda exceção mostra evidência, dono, prazo, rota e fato-fonte; nenhum KPI chama previsão de caixa. |
| 4 | **Laboratório operacional isolado** | Cenários descartáveis de captação → sala → venda → parcelas → comissão → distrato para testes e demos. | Banco/ambiente isolado e dados sintéticos explícitos. | E2E real comprovado sem escrever dado no ambiente operacional. |
| 5 | **Integrações reais e realtime** | PIX/boleto Asaas e atualização operacional estrita quando houver infraestrutura compatível. | Credenciais Asaas, política de webhook, ambiente persistente e decisão de hospedagem. | Pagamento real idempotente, auditado e conciliado; realtime mede atraso e reconexão. |
| 6 | **Inteligência governada** | Assistente que explica risco, sugere próxima ação e cita fatos do TGR. | Dados limpos, métricas maduras, avaliação e controle de permissões. | Toda resposta traz evidência, escopo de acesso e avaliação; IA não decide distrato, cobrança ou comissão sozinha. |

## Wave 2 — execução imediata

A próxima porrada é a **experiência de decisão móvel**. A pesquisa já mostra que tabela densa não pode ser encolhida até virar código de barras; em telas pequenas ela precisa mudar para fila priorizada e drill-down [7] [8]. Também mostra que visões salvas e filtros precisam ser reproduzíveis e visíveis [9] [10] [11].

| Entrega da Wave 2 | Corte funcional | Evidência que será exigida |
|---|---|---|
| Command bar contextual | Atalhos para filtro, recorte salvo, data, ação principal e navegação de módulo. | Navegação por teclado, foco visível e não sobreposição em 390 px. |
| Filtros compactos da Torre | Resumo do recorte + painel expansível + aplicação explícita. | O primeiro bloco mobile reduz altura sem esconder filtros ativos. |
| Listas críticas densas | Tabela desktop com cabeçalho claro e ações; fila mobile com dono, risco, prazo e CTA. | Desktop e mobile de Comercial, Financeiro e Comissões revisados sem dado fabricado. |
| Estados de exceção | Severidade, evidência, responsável, prazo e rota de ação consistentes. | Cada alerta remete a uma fonte e a um destino de resolução. |

### Protocolo de execução da Wave 2

1. Conduzir deep research focado em command bars, filtros analíticos, data grids e experiência de decisão móvel, preservando fontes e síntese.
2. Inspecionar os componentes já existentes antes de criar outro componente que faz a mesma merda com nome em inglês.
3. Especificar os contratos de interface e os estados vazios, de carregamento e erro.
4. Implementar por módulo sem mudar regra de negócio a reboque.
5. Escrever/atualizar testes Vitest, rodar tipo e build, revisar em desktop e mobile.
6. Criar checkpoint, sincronizar GitHub e registrar qualquer bloqueio sem forçar credencial.

## Waves 3 a 6 — recortes que não entram antes da hora

### Wave 3 — Receita, carteira e exceção que vira ação

O foco não é acrescentar mais um gráfico de moeda brilhando como caça-níquel. A central financeira deverá organizar uma fila de priorização por risco de caixa, atraso, comissão em risco, documento pendente e distrato aguardando decisão. O padrão será: **fato → regra → impacto → dono → prazo → ação**. Plataformas de ledger e incidentes tratam estados, prioridade e timeline como evidência operacional [6] [12] [13].

### Wave 4 — Laboratório isolado e prova sem teatro

O laboratório permite entregar demonstração e E2E de casal, tour, contrato, parcela, comissão e distrato sem encostar na operação real. É a onda que fecha a lacuna de evidência dos painéis preenchidos. Dados serão sintéticos, marcados e descartáveis; nunca "demo" escondida no banco vivo.

### Wave 5 — Asaas e realtime, quando a infraestrutura permitir

PIX e boleto não entram como botão de mentira. A integração somente começa com credenciais e contrato de webhook. O realtime estrito entra quando houver hospedagem sempre ativa e medição de falha/reconexão; polling de cinco segundos segue como mecanismo honesto até lá. O modelo de cobrança precisa manter estados e eventos conciliáveis [3] [14].

### Wave 6 — IA que prova, não profetiza

O assistente evolui para sugerir ações a partir da base limpa, mas nunca esconder a fonte ou decidir autonomamente ações financeiras e contratuais. Toda resposta importante deve exibir fatos, período, regra, permissão e incerteza. Meta isolada é manipulável; qualidade, permanência e explicação precisam entrar junto no placar [15] [16].

## Governança de entrega

| Ritual | O que acontece | Definição de pronto |
|---|---|---|
| Antes da wave | Deep research, fontes, síntese e decisão de escopo. | Documento versionado com o que será e não será construído. |
| Durante | Pequenos cortes testáveis, sem seed no banco operacional. | Todo comportamento novo tem contrato, tela e teste compatíveis. |
| Antes de integrar | Tipo, Vitest, build e revisão visual nas larguras relevantes. | Falha corrigida ou fronteira documentada. |
| Depois de integrar | Checkpoint e push ao GitHub privado. | SHA e evidência preservados. |
| Em bloqueio externo | Registrar dependência e alternativa, sem fingir que está pronto. | Credencial, hosting ou ambiente isolado explicitamente pendente. |

## Primeiras decisões já tomadas

**Prioridade 1: Wave 2.** Não negociar. Ela aumenta a velocidade de decisão da operação inteira e reaproveita os dados que já existem, sem depender de credencial externa. O primeiro corte será o modo compacto de filtros da Torre e a command bar contextual; depois vêm as listas densas de Comercial, Financeiro e Comissões.

**Prioridade 2: laboratório isolado.** Ele é a prova que falta para venda, distrato e contrato preenchido. Mas não deve virar desculpa para travar o ganho diário de UI.

**Prioridade 3: transparência econômica.** O motor existe; a interface precisa fazer o gerente enxergar e agir sem abrir cinco telas.

Integrações Asaas, realtime estrito e IA avançada são essenciais, mas dependem de insumos externos. Primeiro o básico que vira decisão todo dia; depois a nave espacial, cabeçudo.

## Referências

[1]: [Clari — Forecast](https://www.clari.com/products/forecast/)  
[2]: [Palantir Foundry — Operational apps](https://palantir.com/docs/foundry/app-building/operational-apps/)  
[3]: [Stripe — Dashboard basics](https://docs.stripe.com/dashboard/basics)  
[4]: [ServiceNow — Advanced Work Assignment queues](https://www.servicenow.com/docs/r/yokohama/servicenow-platform/advanced-work-assignment/awa-queues.html)  
[5]: [Genesys — Real-time supervision](https://help.genesys.cloud/articles/about-real-time-supervision/)  
[6]: [Modern Treasury — Ledgers](https://www.moderntreasury.com/products/ledgers)  
[7]: [Material Design — Adaptive design](https://m3.material.io/foundations/adaptive-design/overview)  
[8]: [Salesforce — lightning-datatable](https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-datatable.html)  
[9]: [Airtable — Views](https://support.airtable.com/articles/5189551686-getting-started-with-airtable-views)  
[10]: [HubSpot — Saved views](https://knowledge.hubspot.com/records/create-and-manage-saved-views)  
[11]: [Jira — Manage filters](https://support.atlassian.com/jira-software-cloud/docs/manage-filters/)  
[12]: [PagerDuty — Incident priority](https://support.pagerduty.com/main/docs/incident-priority)  
[13]: [Jira Service Management — Incident timeline](https://support.atlassian.com/jira-service-management-cloud/docs/what-is-the-incident-timeline/)  
[14]: [Asaas — Cobranças via PIX](https://docs.asaas.com/docs/cobrancas-via-pix)  
[15]: [CNA — Goodhart's Law](https://www.cna.org/analyses/2022/09/goodharts-law)  
[16]: [The American Economic Review — The Multitasking Problem](https://www.journals.uchicago.edu/doi/abs/10.1086/673371)
