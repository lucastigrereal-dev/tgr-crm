# TGR CRM — Relatório final de auditoria

## Evidência final

| Item | Resultado | Evidência |
| --- | --- | --- |
| Branch auditada | PASS | `audit-delivery-2026-08-29` no SHA `081ddc0b9f1cb3b2460011f025e0fae3d74fb43a` |
| CI de qualidade | PASS | GitHub Actions run `33291030111`, job `99202568441` |
| E2E autenticado estrito | PASS | GitHub Actions run `33291030111`, job `99202568403`, 5 cenários Chromium |
| Migração MySQL 8.4 do zero | PASS | etapa `Apply reviewed migrations` do job E2E final |
| Seed e limpeza isolados | PASS | etapas `Seed deterministic TGR fixtures` e `Drop only this run-owned database` |
| Produção e main | PASS | nenhuma alteração, merge ou deploy autorizado/executado |

## Correções confirmadas

- `0026_inventory-unique-constraints.sql` agora cria o índice único de reposição antes de remover o índice que sustenta a chave estrangeira de `units.resortId`. A regressão é protegida por `server/migrationForeignKeyIndexOrdering.test.ts`.
- O Playwright volta a iniciar o servidor gerenciado mesmo com `E2E_BASE_URL`, e honra a porta explícita.
- O comando de desenvolvimento usa `cross-env`, portanto funciona no PowerShell e em CI.
- A suíte estrita espera as mutações tRPC persistirem; a validação de acompanhante lê MySQL diretamente. Seletores de opções de sala consideram o portal do componente de seleção.

## Limites honestos

| Área | Resultado | Nota |
| --- | --- | --- |
| Autenticação e autorização | PASS | Cobertura existente e CI de fluxos autenticados passaram. |
| Ciclo comercial, contrato, distrato e receita | PASS | Cobertura unitária/integrada e cenário estrito de distrato passaram. |
| Reserva, acompanhante, fila, sala e sem-tour | PASS | Cenários reais isolados passaram. |
| Cobrança real e credenciais de gateway | BLOCKED | Fora do escopo seguro: não há credenciais reais nem autorização para cobrança. |
| Homologação local Windows via webServer Playwright | PARTIAL | O servidor inicia diretamente; o gerenciador Playwright local apresentou indisponibilidade de porta. O mesmo fluxo passou no runner Linux descartável. |

Consulte a matriz E2E, o relatório de segurança e o runbook para o detalhe operacional.
