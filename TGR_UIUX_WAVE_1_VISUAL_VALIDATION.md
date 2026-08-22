# TGR-CRM — Validação Visual da Wave 1

**Telas verificadas:** Torre de Comando (`/`) e Central de Comissões (`/comissoes`) em 1440 × 1000, além de Torre e Sala de Vendas (`/sala-de-vendas`) em 390 × 844, com estado de base vazia.

| Critério | Resultado | Evidência observada | Próximo aperto |
|---|---|---|---|
| Navegação por intenção | Aprovado | Sidebar agora agrupa Central, Receita, Relacionamento e Governança, reduzindo a lista plana de módulos. | Criar busca/comando global em wave posterior. |
| Hierarquia editorial-operacional | Aprovado | Título serifado, eyebrow de operação e divisória dão contexto sem competir com filtros e decisões. | Refinar títulos menores nas telas de detalhe. |
| Densidade de comando | Parcialmente aprovado | Filtros, recortes salvos e ações da Torre estão visíveis no primeiro bloco. | Compactar a área de filtros quando houver dados para reduzir espaço vertical. |
| Métricas e leitura financeira | Aprovado | Cartões mostram rótulo, valor tabular, ícone e detalhe com acento restrito. | Aplicar a mesma regra aos cards específicos de cada módulo. |
| Estados vazios | Aprovado com ressalva | Cada vazio explica a ausência e sugere a ação que o alimenta; não inventa dados. | Incluir scaffolds discretos de gráfico/tabela para reduzir sensação de tela vazia. |
| Acento e marca | Aprovado | Verde profundo sustenta autoridade; dourado conduz seleção e ênfase. | Reduzir usos decorativos do dourado em páginas futuras. |
| Acessibilidade visual | Aprovado no recorte | Navegação ativa não depende apenas de cor e estados textuais continuam legíveis. | Validar teclado, foco, contraste e mobile em uma rodada dedicada. |
| Sala de Vendas desktop | Aprovado | Fila, espera, chegada e tour se organizam como colunas operacionais com contagem e ação próxima. | Validar coluna preenchida em laboratório isolado. |
| Sala de Vendas mobile | Aprovado | Métricas e fila se tornam sequência vertical; data e atualização ficam acessíveis sem barra lateral. | Em dados reais, priorizar cards por urgência para reduzir rolagem. |
| Torre mobile | Aprovado com ressalva | Filtros, recorte salvo, métrica e exceção preservam legibilidade em uma coluna. | Criar modo compacto de filtros com resumo/aplicação para encurtar o primeiro bloco. |
| Ficha contratual desktop | Aprovado no estado vazio | A rota inexistente oferece retorno claro; a lista mantém CTA e estado vazio coerentes com o shell premium. | Validar pasta preenchida, carteira, parcelas, ledger e distrato em laboratório isolado. |
| Ficha contratual mobile | Aprovado no estado vazio | CTA de criação e retorno mantêm largura, contraste e alcance adequados, sem dependência da sidebar. | Validar cronograma de parcelas e blocos financeiros preenchidos em base isolada. |

## Limite de evidência desta onda

O redesenho da ficha contratual foi aplicado e passou por TypeScript, Vitest e build. A base conectada não contém contratos e o TGR não deve fabricar casal, venda, parcelas ou distrato para compor prova visual. Portanto, o estado vazio e a rota inexistente foram revisados em desktop e mobile; a validação visual do painel **preenchido** fica deliberadamente condicionada ao laboratório isolado documentado em `E2E_OPERATIONAL_LAB.md`.

> **Conclusão:** a Wave 1 estabeleceu uma casca operacional premium e coerente. A próxima onda não deve trocar estilo; deve aumentar densidade útil, elevar estados preenchidos e criar experiências mobile próprias para fila, alerta e decisão rápida.

## Início da Wave 2 — Torre de Comando

| Critério | Resultado | Evidência observada | Próximo aperto |
|---|---|---|---|
| Filtros mobile compactos | Aprovado | A tela de 390 px mostra período, resumo do recorte, botão de filtros e atalho do mês sem abrir sete campos no topo. | Validar o sheet de filtro com recortes preenchidos no laboratório isolado. |
| Command bar contextual | Aprovado no recorte | Desktop expõe o atalho `⌘/Ctrl + K`; mobile abre o mesmo ponto de comando pelo ícone no resumo do recorte. | Expandir por módulos somente quando as ações tiverem rotas e permissão verificáveis. |
| Torre desktop | Aprovado | Campos, recortes salvos, atalhos temporais, comando e PDF se mantêm próximos da investigação sem formar mosaico de controles. | Aplicar toolbar equivalente às listas de Comercial, Financeiro e Comissões. |

> **Validação técnica da Wave 2, corte Torre:** `pnpm check`, 56 arquivos/144 testes Vitest e `pnpm build` passaram. O aviso de chunk grande do build segue sendo oportunidade de code splitting, não falha de compilação.
