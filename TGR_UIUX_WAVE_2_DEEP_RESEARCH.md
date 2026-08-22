# TGR-CRM — Deep Research da Wave 2: Decisão Móvel e Dados Densos

**Data:** 22 de agosto de 2026  
**Objetivo da wave:** reduzir atrito de decisão na Torre, Comercial, Financeiro e Comissões sem comprimir desktop no celular até a interface parecer nota fiscal molhada.

> **Decisão de produto:** no desktop, filtros e tabelas continuam superfícies de investigação. No celular, o sistema prioriza **recorte ativo, fila acionável e drill-down**, em vez de tentar exibir todas as colunas ao mesmo tempo.

## Fontes investigadas e achados

| Fonte | Achado verificável | Decisão para o TGR |
|---|---|---|
| Carbon Data Table [1] | Barra da tabela é lugar de busca, filtros, exportação e outras ações globais; expansão progressiva preserva densidade; ações de linha ficam explícitas ou em overflow. | Criar uma barra de comando de lista com até cinco ações visíveis e overflow para o resto; detalhe complementar abre por expansão ou rota. |
| Nielsen Norman Group [2] | Em mobile, tabela exige conteúdo legível; cabeçalho/coluna fixa ou recorte explícito; usuário deve selecionar o subconjunto que quer ver. | Não encolher planilha. No celular, transformar listas operacionais em filas com quatro campos: assunto, risco/estado, dono/prazo e CTA. |
| Streak CRM [3] | Command palette reúne entidades, views salvas, ações e recentes; categorias reduzem ruído e permitem navegação por teclado. | A command bar do TGR começa contextual e simples: navegar, abrir recorte salvo, alterar período e disparar ação primária. Sem busca global falsa antes de indexação real. |
| Material Search [4] | Busca deve permanecer próxima ao conteúdo; resultados organizados podem trazer categorias, recentes e sugestões; compacto favorece tela cheia, larguras maiores podem usar painel acoplado. | Em mobile, filtro/busca abre sheet ou superfície de foco; em desktop, permanece ancorado à área investigada. |
| Material Filter Chips [5] | Chips são opções contextuais, não ações finais; em telas compactas o alvo precisa ser o chip inteiro; muitas opções pedem sheet ou rolagem horizontal curta. | Exibir até quatro filtros ativos como chips resumidos; filtros completos entram em sheet. “Aplicar” continua botão, não chip de enfeite. |
| W3C WCAG 2.2 — Focus Appearance [6] | Foco de teclado precisa ser perceptível, com contraste mínimo e área visível adequada; outline sólido de 2 px é uma implementação simples. | Revisar `tgr-focus-ring` e todos os novos controles para contraste e espessura; estado ativo não depende apenas de dourado. |
| W3C WCAG 2.2 — Focus Not Obscured [7] | Cabeçalhos, rodapés e overlays não podem esconder completamente o item focado; conteúdo expansível deve refluír ou reter foco corretamente. | Sheet de filtro mobile será modal e devolverá foco ao gatilho; áreas sticky terão espaço de scroll e não esconderão filtros/linhas focadas. |

## Decisões vinculantes da Wave 2

| Componente | Desktop | Mobile | Anti-padrão proibido |
|---|---|---|---|
| Command bar | Linha contextual junto ao cabeçalho/lista: recorte, período, visão salva, ação primária e `⌘/Ctrl + K`. | Gatilho único no topo; abre painel focado com recentes, ações e recortes. | Palette que finge pesquisar entidades sem índice e devolve vazio inútil. |
| Filtros da Torre | Grade visível com campos essenciais, resumo e atalhos de período. | Resumo de até quatro chips e botão `Filtros`; sheet mostra todos os campos e botão Aplicar. | Formulário gigante aberto ocupando metade da tela. |
| Tabelas | Toolbar, títulos curtos, números tabulares, cabeçalho legível, ações por linha e detalhe progressivo. | Fila/lista com assunto, estado, dono/prazo e CTA; aprofundamento por toque. | Sete colunas comprimidas ou scroll horizontal sem sinalização. |
| Exceções | Severidade, fato, regra, dono, prazo e rota em uma linha investigável. | Ordem por urgência e ação. Evidência entra na segunda camada. | Alerta vermelho sem origem, responsável ou saída. |
| Acessibilidade | Teclado percorre toolbar, linhas, overflow e sheet com foco consistente. | Alvos de toque claros, foco visível e overlays modais. | Drawer aberto cobrindo foco ou chip com alvo minúsculo. |

## Escopo executável

1. **Torre de Comando:** substituir o formulário mobile permanente por resumo do recorte, atalhos de período e sheet de filtros com aplicação explícita.
2. **Componentes compartilhados:** criar a base de command bar contextual, chip de recorte ativo e fila de decisão reutilizável; não duplicar CSS por página.
3. **Módulos de receita:** aplicar a nova barra/lista primeiro em Comercial, Financeiro e Comissões, preservando os contratos tRPC e regras de negócio.
4. **Validação:** cenários vazio, carregando e preenchido quando houver laboratório; 390 px, 768 px e desktop; navegação por teclado nas novas superfícies.

## Restrições e fronteiras

Esta pesquisa é específica para o problema da Wave 2 e complementa a pesquisa de cinquenta benchmarks da Wave 1, registrada em `TGR_UIUX_DEEP_RESEARCH_SYNTHESIS.md`. A tentativa de usar pesquisa paralela ampla foi recusada pelo ambiente por uma restrição de ferramenta, portanto não se afirma falsamente uma nova pesquisa de 50 agentes. As decisões desta wave se apoiam em fontes primárias/curadas, na pesquisa anterior e nas limitações reais do produto.

## Referências

[1]: [Carbon Design System — Data table usage](https://carbondesignsystem.com/components/data-table/usage/)  
[2]: [Nielsen Norman Group — Mobile Tables](https://www.nngroup.com/articles/mobile-tables/)  
[3]: [Streak — Command palette no CRM](https://www.streak.com/post/turbocharge-your-workflow-with-the-new-command-palette)  
[4]: [Material Design 3 — Search guidelines](https://m3.material.io/components/search/guidelines)  
[5]: [Material Design 3 — Chips guidelines](https://m3.material.io/components/chips/guidelines)  
[6]: [W3C — WCAG 2.2 Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)  
[7]: [W3C — WCAG 2.2 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
