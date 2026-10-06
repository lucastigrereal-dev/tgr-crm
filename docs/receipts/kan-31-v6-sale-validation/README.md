# Receipt: KAN-31, CRM V6 VENDA VALIDADA

**Estado do CRM: IN REVIEW.** O CRM está tecnicamente pronto. Para ir a piloto ainda faltam dois HUMAN_GATEs (abaixo) e a jornada integrada CRM + suite (NOT_RUN). **Não está HOMOLOGATED.**

| Item | Valor |
|---|---|
| Branch | `kan-31/v6-sale-validation` (um writer; nenhum push em `main`) |
| Base | `origin/main` em `d5d6880` |
| Base V6 incorporada | `origin/kan-v6/final-goal-kywbhh` em `c8c976c` (merge `70ae6a1`). Foi empurrada por outra sessão em 2026-10-06 por volta de 20:55Z, com a 0044 e o serviço de validação; incorporei em vez de reescrever. Esse branch não foi alterado. |
| Suite lida (só leitura) | `tgr-commercial-suite@claude/tgr-core-v6-final-7mvbjm`, HEAD `8f14365`. `488c838` é ancestral do HEAD, e os receptores (`crm-sale-validation-intake.ts`, `financial-layer/server/src/{service,app}.ts`) não têm diff entre `488c838` e `8f14365`. |
| Bancos | Só MySQL 8.4 descartável em container local (`127.0.0.1:43316`), bancos `crm_v6_*_test`. Nenhum banco real ou compartilhado foi usado e nenhuma migration real foi aplicada. |

## Decisões de negócio aplicadas (sem reinterpretar)
- VENDEU é aceite comercial (`captures.recordCommercialOutcome`). Venda VALIDADA = `sale_validations.validatedAt`, gravado só por `saleValidation.validateSale`, com os quatro portões abertos e confirmação explícita do gerente.
- O "gerente" do CRM corresponde a `admin` (capacidades `sale.payment.confirm` e `sale.validate`). `CRM_MANAGER_ROLE` continua POLICY_PENDING.
- `COMMISSION_POLICY = NOT_APPROVED`: nenhum percentual, prazo ou estorno foi criado.
- Retenção: `BUSINESS_PREFERENCE_PENDING_LEGAL`. Não há purge automático e este trabalho não faz alegação de LGPD.

## Matriz requisito → evidência
| # | Obrigação | Estado | Evidência |
|---|---|---|---|
| 1 | Estado por portão: ator, instante e trilha append-only | PROVED | `sale_validations` (0044) recebe na 0045 `contractGeneratedAt`, `contractSignedAt`, `documentStoredAt` e `documentRef`. A trilha `sale_validation_events` é append-only por trigger e recebe `externalSaleId`. Testes: `saleValidation.mysql.test.ts` (13), `saleValidation.test.ts` (17). |
| 1 | `document_ref` opaco, sem URL, token ou PII; PDF fora do Git | PROVED | `saleDocumentRef()` gera `crm-doc:<contrato>:<documento>`. A trilha guarda essa referência e não o `storageKey`. Testes: `saleValidatedConsumerContract.test.ts` e o caso "trilha append-only guarda a referência opaca". |
| 1 | `validated_at/by` só como transição explícita com os 4 portões | PROVED | `validateSale` recusa com `SALE_VALIDATION_GATES_MISSING` quando falta portão e com `SALE_GATE_TIMESTAMP_INVALID` quando um portão é posterior à validação. |
| 2 | RBAC: closer, finance e service não confirmam nem validam | PROVED | `rbacMatrix.test.ts`: `saleValidation.confirmPayment` e `validateSale` dão FORBIDDEN para seller, finance, service e user, e passam para admin. |
| 3 | Auditoria: ator, instante, antes/depois, correlationId, externalSaleId | PROVED | `sale_validation_events` (`beforeJson`, `afterJson`, `correlationId`, `externalSaleId`) e `audit_logs` com resumo. A rejeição também deixa trilha. |
| 4 | Outbox na mesma transação; eventId `crm-sale-<id>-validated` | PROVED | `contract.status.updated(active)` e `sale.validated` são gravados na transação de `validateSale`. |
| 4 | Sales: `crm.sale.validated.v1` exatamente no formato aceito | PROVED (o código anterior era CONFLICT) | `buildSaleValidatedBody` agora envia `validatedBy` e `gates{...}`. O corpo herdado seria recusado com 422 `SALE_VALIDATION_GATES_INCOMPLETE`. O parser do Sales foi replicado em `saleValidatedConsumerContract.test.ts`. |
| 4 | Financial: `tgr.events.v1` `sale.validated` `{contractId, saleId, validatedAt, validatedBy}` | PROVED (o código anterior era CONFLICT) | O payload herdado tinha campos extras, `customerId` enriquecido e `contractId` numérico, o que daria 400 no `z.strictObject`. `sale.payment.confirmed` saiu do feed do Financial, porque não está no enum do receptor. |
| 4 | Reação às respostas (PIL-008) | PROVED | `bridgeRefusalContract.test.ts` (15): code → DLQ na 1ª tentativa, com o motivo; 404/503 sem code → retry; 200 replay → entregue; Financial 409 sem code → retry, nunca DLQ; 429 com code → transitório. |
| 5 | Comissão nunca devida/pagável antes de `validated_at` | PROVED | Automática (baixa manual e webhook) e `record`, herdados. Novo: `commissions.setStatus(approved/paid)` recusa com `COMMISSION_REQUIRES_VALIDATED_SALE`. Testes em `commissions.setStatus-sale-validation.test.ts`. |
| 6 | Ativação vs validação | PROVED: **ativação ≡ validação** | Só `validateSale` leva `draft/pending_signature` a `active` e emite `contract.status.updated(active)`, que o Relationship transforma em `crm.contract.activated.v1` (D1/D3/D5/D7). `create` aceita só `draft/pending_signature`. `updateStatus(→active)` só é aceito de `overdue` com `activatedAt` já preenchido (Red Team P0-1). O webhook Clicksign não ativa. Testes: `contracts.sale-validation-bypass.test.ts`, `eSignatureService.mysql.test.ts`. |
| 7 | Regressão: ativação, distrato, RBAC, cancelled (Sales + Relationship), `contract.created.v2` | PROVED | Suite completa 676/676 com MySQL (abaixo). |
| 8 | Migration 0043 (e 0044/0045) só em banco descartável | PROVED | Migradas do zero até a 0045 em `crm_v6_rc_test`: 52 tabelas, 2 triggers, 46 entradas no journal. `drizzle-kit generate` respondeu "No schema changes". |
| — | Backfill de contratos `active` anteriores à V6 | HUMAN_GATE | Ver abaixo. |
| — | Jornada integrada CRM + suite | NOT_RUN | Ver abaixo. |

## Commits (`d5d6880..HEAD`, deste branch)
| SHA | O que muda |
|---|---|
| `70ae6a1` | Merge da base V6 (`kan-v6/final-goal-kywbhh`): 0044, serviço, router, UI, travas de comissão herdadas |
| `65c550f` | 0045: instantes dos portões, `documentRef` opaco e `externalSaleId`; `validatedAt` com teto do segundo |
| `03fce6e` | Corpo do Sales e payload do Financial no formato exato dos receptores |
| `2ae1b57` | Outbox PIL-008: code → DLQ, transitório → retry |
| `6652ef7` | `commissions.setStatus` exige venda validada |
| `9dfc158` | Fixtures de integridade de comissão apontam para contrato validado |
| `15e6651` | Red Team P0-1: contrato criado em atraso não vira `active` |
| `c56ba7a` | Red Team P1-2 e P1-3: corridas; a trilha deixa de guardar `storageKey` |
| `a56cca0` | Red Team P2: fato inválido vira recusa visível |

## RED → GREEN (TDD)
Cada regra nova nasceu com teste falhando contra o código anterior. As saídas completas foram guardadas na scratchpad da sessão.
| RED | Falhou (antes) | GREEN (commit) |
|---|---|---|
| red-1 contrato do consumidor | 3/5: corpo do Sales seria 400/422; payload do Financial não-estrito | `03fce6e`: 5/5 |
| red-2 MySQL instantes dos portões | 1/11: payload sem `validatedBy` e `gates` | `65c550f`: 11/11 |
| red-3 `saleGateTimestamps` / `gatesNotAfter` | 3/17 (função inexistente) | `65c550f`: 17/17 |
| red-4 recusa PIL-008 | 11/15 | `2ae1b57`: 15/15 |
| red-5 `setStatus` sem validação | 4/6 (approved/paid passavam) | `6652ef7`: 6/6 |
| red-6 Red Team P0-1 | 4/14 (create overdue; overdue→active sem ativação prévia) | `15e6651`: 14/14 |
| red-7 Red Team P1-2/P1-3/P2 | 4/13 (recusa falsa na corrida; pagamento em contrato distratado; storageKey na trilha) | `c56ba7a`: 13/13 |

Três ajustes de teste não tiveram RED separado:
- A mudança de `not_applicable` para recibo de recusa (`a56cca0`, P2) foi escrita junto com o código.
- Os fixtures de `commissions.integrity.test.ts` (`9dfc158`) foram ajustados porque a regra nova os tornava inválidos.
- Testes herdados que fixavam o contrato antigo (`saleValidatedBridge.test.ts`, `eventContract.test.ts`, expectativa `signedAt` → `contractSignedAt`) foram reescritos para o contrato real.

Nenhum teste foi pulado, desabilitado ou afrouxado.

## Comandos e resultados finais (HEAD `a56cca0`)
```
docker run -d --name crm-v6-throwaway -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1:43316:3306 mysql:8.4
docker exec crm-v6-throwaway mysql -uroot -e "create database crm_v6_rc_test"
DATABASE_URL=mysql://root@127.0.0.1:43316/crm_v6_rc_test pnpm exec drizzle-kit migrate   # migrations applied successfully (0000..0045)
pnpm check                                                                                # PASS (tsc --noEmit)
TGR_MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1:43316/crm_v6_rc_test pnpm test           # 166 files / 676 passed, 0 skipped
pnpm test                                                                                 # 158 passed + 8 skipped files / 641 passed, 35 skipped
pnpm build                                                                                # PASS
DATABASE_URL=… pnpm exec drizzle-kit generate                                             # No schema changes
```
- Baseline antes deste trabalho (merge da base V6, MySQL): 163 arquivos / 641 passed, 0 skipped.
- Sem MySQL, os 35 skips são exatamente os 8 arquivos `*.mysql.test.ts` (`describe.skipIf(!TGR_MYSQL_INTEGRATION_URL)`). Nesse modo eles contam como **NOT_RUN**, não como PASS. A prova deles é a execução com MySQL acima.

## Red Team independente
Feito por um agente separado, só leitura, depois da implementação: 2 P0, 4 P1, 9 P2.
| Achado | Decisão |
|---|---|
| P0-1: contrato criado `overdue` virava `active` sem validação | **Corrigido** (`15e6651`) |
| P0-2: contratos `active` anteriores à V6 nunca validam e a comissão deles fica travada | **HUMAN_GATE** `LEGACY_ACTIVE_BACKFILL`. O sistema falha fechado. Uma "validação histórica" seria política nova e não foi inventada. |
| P1-1: triggers da 0044 (TiDB não suporta; MySQL com binlog sem SUPER exige `log_bin_trust_function_creators` ou privilégio `TRIGGER`) | **Risco documentado.** Aplicar migration real é HARD GATE. Antes de aplicar no piloto, confirmar o engine (o piloto usa `mysql:8.4`) e os privilégios do `tgr_app`. |
| P1-2: corrida entre dois gerentes gerava recusa falsa | **Corrigido** (`c56ba7a`) |
| P1-3: `confirmPayment` sem trava do contrato | **Corrigido** (`c56ba7a`) |
| P1-4: 404 sem code do Sales trava o cursor do pump; 409 sem code do Financial tenta para sempre | **Aceito por contrato** (o Sales exige retry no 404; o Financial declara 409 sem code como transitório). O alerta é `onError` a cada tick. Próximo passo sugerido: relatório de eventos parados há mais de N horas. |
| P2: `storageKey` na trilha append-only | **Corrigido** (`c56ba7a`) |
| P2: fato inválido virava `not_applicable` | **Corrigido** (`a56cca0`) |
| P2: portões "gerado/assinado" aceitam qualquer documento; skew entre relógio do banco e do app maior que 1s; `externalSaleId` varchar(64) vs 120; `audit_logs` sem correlationId (a trilha cobre); leitura de `isSaleValidated` fora da transação em `finance.ts` (falha fechado); seed e2e com `active` sem validação | **Registrados, não corrigidos** (baixo risco, falham fechado ou são fixture) |

## HUMAN_GATEs e limitações
1. **`LEGACY_ACTIVE_BACKFILL`**: contratos `active` de antes da V6 (inclui importação CSV e seed e2e) não têm `sale_validations`. A comissão deles fica bloqueada até o Lucas decidir se haverá validação histórica e com que regra.
2. **`CRM_MANAGER_ROLE`**: gerente = `admin` até existir papel próprio. Só `shared/permissions.ts` muda.
3. Contrato sem linhagem Sales Command: `sale.validated` não é enviado ao Financial (recibo `financial_not_applicable`, porque o Financial exige `saleId`). A comissão desses contratos no Financial fica aguardando (409 sem code).
4. Migrations 0044 e 0045 **não** foram aplicadas em banco real (HARD GATE).
5. Reprocessar um evento na DLQ significa apagar a linha de `audit_logs` com o `idempotencyKey` do recibo (roteiro do piloto, já existente).
6. Nenhum documento assinado, PII ou segredo foi commitado. Os fixtures são sintéticos (`SYN`).

## Jornada integrada CRM + suite: NOT_RUN
Não rodou aqui porque esta sessão não sobe Sales, Financial e Relationship da suite com bancos próprios. É uma jornada multi-serviço; o destino é o KRATOS ou uma sessão com os dois repos e Postgres/MySQL descartáveis.

Passo exato: estender a jornada 1 de `apps/sales-command/scripts/pilot-journeys.mts` (suite) com:
1. VENDEU no Sales, depois `sale.ready_for_contract.v1` para o CRM (`/api/integration/sales-command/...`).
2. No CRM: rascunho, `saleValidation.confirmPayment` (admin), upload do contrato, assinatura (Clicksign sandbox ou `uploadDocument signed:true` por admin) e documento armazenado.
3. `saleValidation.validateSale`; rodar um tick dos pumps Sales, Financial e Relationship.
4. Assert no Sales: estado derivado VALIDATED (`sale_validations` com `sourceEventId=crm-sale-<id>-validated`).
5. Assert no Financial: `financial_contracts.validatedAt` preenchido.
6. Comissão: `commission.status.updated paid` antes do passo 3 é recusado (CRM `COMMISSION_REQUIRES_VALIDATED_SALE`; Financial 409 sem code) e é aceito depois.
7. Relationship: `crm.contract.activated.v1` só depois do passo 3.
