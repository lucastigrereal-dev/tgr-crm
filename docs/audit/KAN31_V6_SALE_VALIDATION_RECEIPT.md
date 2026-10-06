# Receipt — KAN-31 V6 Wave 1 (CRM): venda validada (ADR-007)

Branch `kan-v6/final-goal-kywbhh` (base `main` d5d6880). Código em `8abd80a`; este receipt é o commit seguinte. Sem push, sem merge, sem migration em banco real.

## Commits
| SHA | Conteúdo |
|---|---|
| 1cb5d32 | migration 0044: `sale_validations`, `sale_validation_events` (append-only por trigger), 4 colunas de resultado comercial em `capture_records`; schema + snapshot + journal |
| eb5a1ff | `server/saleValidation.ts` (gates puros), capacidades `sale.payment.confirm`/`sale.validate`, eventos `sale.payment.confirmed`/`sale.validated`, FINANCIAL_EVENT_NAMES, snapshot de eventos |
| 01fa518 | `saleValidationService` + router `saleValidation`; webhook `envelope_closed` não ativa mais |
| e5cd4cc | `contracts.create/updateStatus` não ativam; `uploadDocument.signed` só com `document.sign` |
| 1904733 | comissão exige venda validada (automática e manual) |
| e9d6372 | `captures.recordCommercialOutcome` |
| e5283b3 | `crm.sale.validated.v1` ao Sales + amostras no contrato de eventos |
| 8abd80a | card de portões no detalhe do contrato; RBAC `sale.*` na matriz |

## Comandos e resultados
Banco descartável: container `tgr-sales-v3-mysql-1` (127.0.0.1:43316), bancos criados só para a execução (`crm_v6_*_test`), migrados do zero com `DATABASE_URL=… pnpm exec drizzle-kit migrate` (52 tabelas, 2 triggers) e removidos no fim.
- `pnpm check` (tsc): PASS.
- Baseline (main d5d6880) com MySQL: 156 arquivos / **562 passed**, 0 skipped. Sem MySQL: 540 passed / 22 skipped.
- Final com `TGR_MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1:43316/<db>_test`: 163 arquivos / **641 passed**, 0 skipped (8 `*.mysql.test.ts`, incl. `saleValidation.mysql.test.ts` 11 testes e `schemaDrift` verde com a 0044).
- Final sem MySQL: 155 arquivos passed + 8 skipped / **608 passed, 33 skipped** (skips = os 8 arquivos mysql, como antes).
- `pnpm build`: PASS.
- `drizzle-kit generate` após a 0044: "No schema changes".

## Testes da regra antiga alterados (nenhum pulado/desabilitado)
1. `contracts.events.test.ts`: criação "active" -> "pending_signature" (create active agora é recusado); `uploadDocument signed:true` por admin agora grava e emite `signed:true`.
2. `eSignatureService.mysql.test.ts`: envelope_closed agora deixa `pending_signature`, marca `signedAt`, sem `contract.status.updated`; `contract.signature.completed` continua 1x.
3. `commissionPolicySafety.test.ts`: `canCommissionBecomeDue` tem 3º argumento obrigatório; casos sem validação = false; checa que os call sites passam `saleValidated`.
4. `finance.installment-integrity.test.ts`: o mock ganhou a leitura de `sale_validations` (venda não validada, `commissionBlocked:true` preservado).
5. `commissions.record-integrity.test.ts`: `contractId` obrigatório e venda validada no fixture; mock de `revenueQualitySync` (agora há contrato no caminho feliz).
6. `rbacMatrix.test.ts`: só acrescentou as duas ações novas.

## Limitações / riscos abertos
- Importação CSV de contratos (`imports`) e seed e2e (`scripts/seed-e2e-isolated.mjs`) ainda gravam contratos `active` direto no banco: são carga histórica/fixture, sem linha em `sale_validations`, logo sem comissão automática. Decisão de produto pendente.
- Contratos `active` anteriores à 0044 não têm `sale_validations`: comissão automática/manual fica bloqueada para eles até haver backfill decidido pelo negócio. Regularização `overdue -> active` por `updateStatus` segue permitida.
- `signedAt` quando o contrato não tem a data: usa `contract_documents.createdAt` do documento escolhido (não existe `signedAt` por documento).
- O código de recusa (ex.: `SALE_VALIDATION_GATES_MISSING`) vai no início da mensagem do TRPCError e em `cause.code/missing`; tRPC não serializa `cause` ao cliente.
- `sale_validation_events` é append-only por trigger MySQL (UPDATE/DELETE recusados); só existe em bancos migrados pela 0044.
- UI: só o card no detalhe do contrato; não há botões de VENDEU/CAIU EM MESA na tela da sala (procedure pronta: `captures.recordCommercialOutcome`).
- Financial adiciona `customerId` ao payload (enriquecimento já existente do pump) — não está em `allowedPayloadFields`.
- Políticas pendentes (não inventadas): `CRM_MANAGER_ROLE`, `GOAL_BASIS`, `CAIU_EM_MESA_RECOVERY`, `CAIU_EM_MESA_REASON_CATALOG`, `COMMISSION_RATES_TIMING_CANCELLATION`, `RETENTION`.
- Nenhum documento assinado, PII ou segredo foi commitado; fixtures usam dados sintéticos.
