# Validação visual — Recortes salvos da Torre de Comando

**Data:** 22 de agosto de 2026.  
**Rota:** `/`.  
**Viewport:** desktop, 1280 × 720.

O seletor **Aplicar recorte salvo** e o botão **Salvar recorte** aparecem no bloco principal de filtros, ao lado das ações de período e PDF. A disposição mantém os filtros de período, equipe, campanha, empreendimento, sala e status operacionais legíveis no primeiro viewport; o controle novo não desloca os KPIs nem quebra a hierarquia da Torre.

O ambiente atual não contém recortes gravados, portanto o estado vazio do seletor é esperado. A prova automatizada em `server/dashboard.saved-views.test.ts` valida a criação, a leitura de recorte próprio e compartilhado e o bloqueio de exclusão de item de terceiro. A prova com lista preenchida será executada no laboratório isolado, sem semear filtros artificiais em operação.
