# TGR CRM — Questões conhecidas

| Item | Resultado | Evidência e encaminhamento |
| --- | --- | --- |
| Gateway de pagamento real | BLOCKED | Não há credenciais reais nem autorização para cobrar. Manter sandbox/simulação até aprovação de operação. |
| Playwright webServer no Windows local | PARTIAL | O comando `pnpm dev` foi corrigido e responde quando iniciado diretamente; o gerenciador local do Playwright não observou a porta durante esta auditoria. O CI Linux final passou. Investigar separadamente sem enfraquecer a trava E2E. |
| Aviso de chunk >500 kB do Vite | PARTIAL | Orçamento gzip aprovado; avaliar divisão adicional de chunks fora desta correção. |
| Aviso de build script de `core-js` | PARTIAL | Instalação congelada e CI passaram. Aprovar ou manter bloqueado por decisão de dependências. |
| Commit local `f3a1011` mencionado no histórico | BLOCKED | Não estava disponível; não foi reconstruído nem inventado. Não impediu a entrega deste branch. |
