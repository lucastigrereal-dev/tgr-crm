# TGR CRM — Matriz E2E

Referências: GitHub Actions `33291030111` (Linux, auditoria anterior) e run local Windows `win_20260919_g` em 19/09/2026.

| Jornada | Linux CI | Windows local | Prova |
| --- | --- | --- | --- |
| CSV: prévia, importação e undo | PASS | PASS | UI real + MySQL sem registro após undo |
| Funil: download XLSX e PDF | PASS | PASS | downloads reais validados |
| Reserva: check-in, acompanhante, fila e check-out | PASS | PASS | mutações tRPC + persistência MySQL |
| Sala: chegada, mesa, time, tour e sem-tour | PASS | PASS | UI real + estados finais persistidos |
| Distrato: solicitar, aprovar e executar uma vez | PASS | PASS | cenário autenticado estrito |
| Banco exclusivo do run | PASS | PASS | `E2E_RUN_ID`, confirmação explícita e nome `_e2e` |
| Cleanup do banco | PASS | PASS | `CLEANUP_EXIT=0` |
| Encerramento do servidor | n/a | PASS | porta 43337 livre após o run |
| Reutilização de servidor antigo | n/a | BLOQUEADA | `reuseExistingServer: false` + preflight de porta |
| Gateway real | BLOCKED | BLOCKED | sem credencial/autorização de cobrança |

Infra Windows validada: Node 22.23.2, MySQL 8.4 descartável e Chromium Playwright v1234.