# TGR CRM — Questões conhecidas

| Item | Resultado | Evidência e encaminhamento |
| --- | --- | --- |
| Gateway de pagamento real | BLOCKED | Não há credenciais reais nem autorização para cobrar. Manter sandbox/simulação até aprovação operacional. |
| Integrações externas Forge/Manus | BLOCKED | `BUILT_IN_FORGE_API_URL` e `BUILT_IN_FORGE_API_KEY` não estão configuradas no laboratório local. O núcleo do CRM e os E2Es canônicos não dependem delas. |
| Playwright webServer no Windows local | CLOSED / PASS | Corrigido em 19/09/2026. Causa raiz: processos antigos do CRM ocupavam a porta e `reuseExistingServer` permitia reutilização indevida. Run `win_20260919_g`: 5/5 PASS, cleanup 0 e porta 43337 livre ao final. |
| Aviso de chunk >500 kB do Vite | ACCEPTED | O aviso bruto permanece em `exceljs`, mas os módulos pesados estão lazy. Budget gzip aprovado: app 148.2 KB/450 KB; Excel 264.4 KB/300 KB; PDF 123.4 KB/150 KB. |
| Aviso de build script de `core-js` | ACCEPTED | Instalação congelada, testes e build passam. Não foi liberada execução extra de script de dependência sem necessidade. |
| Commit local `f3a1011` mencionado no histórico | BLOCKED / NON-BLOCKING | Não estava disponível e não foi reconstruído. Não impede o release candidate auditado. |

Última verificação local: 19/09/2026, branch `audit-delivery-2026-08-29`, head `a352ade`.