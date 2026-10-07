# Receipt: KAN-31, CRM V6 VENDA VALIDADA

**Estado do CRM: IN REVIEW.** O CRM está tecnicamente pronto e a jornada integrada CRM + suite **rodou** (addendum de 2026-10-07 no fim). Para ir a piloto faltam os HUMAN_GATEs listados abaixo. **Não está HOMOLOGATED.**

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
| — | Jornada integrada CRM + suite | PROVED (2026-10-07) | Linux, 5 apps, bancos descartáveis: 44/44 passos (A 19, B 9, C 6, E 4, V 6). D e S: NOT_RUN (harness só Windows). Ver addendum. |

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
3. Contrato sem linhagem Sales Command: `sale.validated` não é enviado ao Financial (recibo `financial_not_applicable`, porque o Financial exige `saleId`). A comissão desses contratos no Financial fica aguardando (409 sem code). **Superado em KAN-30 (tgr-crm #39):** o Financial aceita `saleId` nulo, então o evento passa a ser enviado com `saleId: null` e a venda validada entra no oficial.
4. Migrations 0044 e 0045 **não** foram aplicadas em banco real (HARD GATE).
5. Reprocessar um evento na DLQ significa apagar a linha de `audit_logs` com o `idempotencyKey` do recibo (roteiro do piloto, já existente).
6. Nenhum documento assinado, PII ou segredo foi commitado. Os fixtures são sintéticos (`SYN`).

## Jornada integrada CRM + suite (plano original; executada no addendum)
Não rodou aqui porque esta sessão não sobe Sales, Financial e Relationship da suite com bancos próprios. É uma jornada multi-serviço; o destino é o KRATOS ou uma sessão com os dois repos e Postgres/MySQL descartáveis.

Passo exato: estender a jornada 1 de `apps/sales-command/scripts/pilot-journeys.mts` (suite) com:
1. VENDEU no Sales, depois `sale.ready_for_contract.v1` para o CRM (`/api/integration/sales-command/...`).
2. No CRM: rascunho, `saleValidation.confirmPayment` (admin), upload do contrato, assinatura (Clicksign sandbox ou `uploadDocument signed:true` por admin) e documento armazenado.
3. `saleValidation.validateSale`; rodar um tick dos pumps Sales, Financial e Relationship.
4. Assert no Sales: estado derivado VALIDATED (`sale_validations` com `sourceEventId=crm-sale-<id>-validated`).
5. Assert no Financial: `financial_contracts.validatedAt` preenchido.
6. Comissão: `commission.status.updated paid` antes do passo 3 é recusado (CRM `COMMISSION_REQUIRES_VALIDATED_SALE`; Financial 409 sem code) e é aceito depois.
7. Relationship: `crm.contract.activated.v1` só depois do passo 3.


---

## Addendum 2026-10-07: jornada integrada + teste no navegador

### Ambiente
Tudo em Linux, nesta sessão, só com recursos descartáveis em 127.0.0.1:
- 5 apps no ar: Sales 43501, Relationship 43502, Recovery 43503, Financial 43504 e CRM 43505 (este branch).
- MySQL de piloto efêmero em 43410 e banco do Sales no MySQL de teste em 43316.
- Personas e chaves geradas só para a rodada (`pilot-personas.mts env`). Nenhuma foi commitada.

O harness da suite (`pilot.sh`) é Windows: caminhos `C:/`, `tasklist`, `netstat` e `python`. Usei um wrapper Linux equivalente, fora dos repos, que cobre `env`, MySQL, migrations, `setup` com 60 frações, `provision`, `servers` e `verify`. Na 1ª subida esqueci `F5_CRM_FRACTIONS=60`: o CRM ficou com 5 frações e recusou 8 vendas com `422 INSUFFICIENT_INVENTORY` (DLQ correta). O ambiente foi recriado do zero e a contagem final vem da rodada limpa.

A mudança na suite está em `suite-pilot-journeys-v6.patch`. Ela não foi empurrada para a suite porque o branch é de outro writer.
- **Jornada A:** o passo 4 (ativação direta, agora recusada por design) virou o fluxo V6 completo. Foram adicionados a comissão antes/depois da validação e o helper `crmValidateSale`.
- **Jornadas S e V e `f5-crm.mjs activate`:** passam a validar a venda em vez de ativar direto.

### Resultado das jornadas (ambiente limpo)
| Jornada | Resultado |
|---|---|
| A: VENDEU → CRM `pending_signature` → bypass recusado (`CONFLICT`) → seller/finance/service `FORBIDDEN` → validar sem portões `PRECONDITION_FAILED` → comissão antes da validação `PRECONDITION_FAILED` → gerente confirma pagamento → contrato assinado anexado → antes da validação: Relationship 0 passos, Sales e Financial sem validação → gerente valida → Sales `sale_validations` (`crm-sale-<id>-validated`, `documentRef crm-doc:<c>:<d>`) → Financial `validated_at` → Relationship D1/D3/D5/D7 → baixa de parcela → comissão depois: lança, aprova, paga → Financial `COMMISSION SETTLED` | **19/19 PASS** |
| B: distrato (RBAC, cancelamento no Sales e no Financial, Relationship ENDED com os passos preservados) | **9/9 PASS** |
| C: NO_SALE → Recovery → reativação → venda de retorno CONVERTED | **6/6 PASS** |
| E: segurança (403 do agent, `strictObject` do Financial, replay 409, sessões inválidas 401) | **4/4 PASS** |
| V: volume (10 vendas, correlação 10/10 nos três consumidores, 2 distratos, 2 recuperações, zero duplicidade, cockpit = fatos do banco) | **6/6 PASS** |
| D (Relationship fora do ar) e S (standalone) | **NOT_RUN**: derrubam e sobem servidores via `netstat`/`tasklist` do Windows |

RED da jornada A original contra este CRM:
- A4 (`contracts.updateStatus active`) falhou com `409 CONFLICT`.
- A6 confirmou que o Relationship não inicia D1–D7 sem validação.

Esse é o comportamento V6 esperado e é o motivo da mudança na jornada.

### Teste no navegador (Chromium headless; 4 agentes em paralelo + verificação própria)
| Frente | Resultado |
|---|---|
| CRM gerente (syn.admin) | **PASS**: login, "Novo contrato" sem "Ativo", 5 portões pendentes, "Validar venda" desabilitado, confirmar pagamento, anexar e confirmar assinatura, validar, toast "Venda validada. Contrato ativo.", 5 portões ok, ACTIVE |
| CRM RBAC (seller/finance/service) | **PASS** no servidor: só 403, zero 5xx, nenhum `pageerror`; nenhum papel vê "Confirmar pagamento"/"Validar venda". Achado P2 de UI corrigido (abaixo) |
| Sales (4 personas) | **PASS**: venda completa pela UI; venda validada aparece como "Venda validada (oficial, CRM)"; distrato como "Cancelada pós-contrato" |
| Relationship (admin/agent) | **PASS**: D1/D3/D5/D7 só em venda validada; agent sem "Criar jornada" e com 403 no manual |
| Financial + Recovery (API, sem UI) | **PASS**: todas as rotas de operador, 401 sem token ou com token inválido, 403 do agent; CRM ↔ Financial 3/3 validações; a única comissão liquidada é de contrato validado |

### Correções vindas do teste no navegador (CRM, este branch)
| Commit | Achado | Correção | Prova |
|---|---|---|---|
| `b7787bf` | P2: número longo do contrato (`SC-<hex>`) passava por cima de "Anexar documento" e do seletor de status, que cortava "Ativo (só pela validação da venda)" | Título quebra em qualquer ponto; ações não encolhem; seletor cresce com o texto | Playwright: `overlap=false` nos contratos ativo e pendente |
| `80cd023` | P2: seller/service viam Financeiro, Reajustes, Equipe etc.; 403 virava R$ 0,00 enganoso ou "Carregando..." eterno; o detalhe do contrato chamava rotas do financeiro | `menuPathRoles`/`canOpenMenuPath` (`shared/permissions.ts`) espelham o procedure de cada rota; menu filtrado; rota proibida mostra "Sem permissão para esta área"; cards financeiros só para admin/finance | RED `red-8` (14 testes) → GREEN; Playwright nas 4 personas: menus corretos e **0 respostas 403** no detalhe do contrato |

### Achados fora do CRM (não corrigidos aqui)
- **Suite, Relationship (P2):** `listCases` (`apps/relationship/server/src/service.ts`) lista só ACTIVE. Um caso ENDED por distrato não abre pela tela, só por `GET /api/cases/:id`. É gap de produto da suite.
- **Política de negócio (HUMAN_GATE):** se uma comissão foi paga antes de um distrato, ela continua paga (caso do contrato 1). Estorno de comissão está em `COMMISSION_POLICY = NOT_APPROVED`; não foi inventado.

### Testes do CRM depois das correções
- `pnpm check`: PASS.
- `pnpm test` com MySQL (banco novo, 0001..0045): 167 arquivos, **690 passed**.
- Sem MySQL: 655 passed, 35 skipped (os 8 arquivos `*.mysql`, que nesse modo contam como NOT_RUN).
- **Intermitente não identificado:** 2 rodadas falharam 1 teste cada, em cerca de 25 rodadas. A primeira rodou ao mesmo tempo que o build e o restart do CRM; a segunda foi a 1ª rodada após migrar um banco novo. Não reproduziu em cerca de 21 tentativas seguidas (cache frio, banco novo, com e sem MySQL), e o nome do teste não foi capturado. Fica registrado como pendência aberta, não como "flake resolvido". Próximo passo: rodar com `--reporter=junit` no CI para capturar o nome.

---

## Addendum 2026-10-07 (tarde): decisões do Lucas, merge com a main e GO

### Decisões de negócio (Lucas, 2026-10-07; palavras dele resumidas)
| Política | Decisão | Efeito no sistema |
|---|---|---|
| `LEGACY_ACTIVE_BACKFILL` | **Não precisa.** Não deve haver contrato antigo; se houver, a comissão dele já foi acertada por fora. | Nenhum backfill. Contrato `active` sem `sale_validations` continua sem comissão automática (falha fechada), como esperado. |
| Estorno de comissão (`COMMISSION_CLAWBACK`) | **Não existe estorno.** O vendedor não devolve comissão. Ele recebe no fim do mês ou depois da venda validada. Caso de até 7 dias: possível devolução, ajustada **manualmente pelo pós-vendas**. | Nada automático. A fila manual de revisão da main (ADR-010, 0045/0046: distrato enfileira comissão paga para decisão humana) é compatível: ninguém estorna sem decisão do pós-vendas. Comissão sem contrato não aprova nem paga. |
| Merge do PR #35 | **GO** ("pode juntar tudo"). | Merge na `main`. O CI não faz deploy (`.github/workflows/ci.yml` só testa/builda). Migration real e deploy continuam **HARD GATE separado**. |

### A main mudou durante o trabalho (PR #37, "TGR Core V6 + Fase 1")
Outra sessão juntou na `main` uma evolução paralela do V6. Encontrei estas diferenças:
- **Bug de integração na main:** ela enviava `crm.sale.validated.v1` e `sale.validated` no **formato antigo**. No Sales isso vira 422 `SALE_VALIDATION_GATES_INCOMPLETE` e vai para a DLQ na 1ª tentativa. No Financial vira 400. Na main, venda validada **não chegaria** em nenhum dos dois. Este branch corrige.
- **Colisão de migrations:** 0045/0046 da main (fila de estorno) × 0045 daqui. O snapshot dos portões virou **0047**.
- **Correções duplicadas** (gates, travas, recusa com code). Ficou a versão mais rígida de cada lado.

Merge `20a5700`. Resolução, conflito por conflito, na mensagem do commit.

### Prova depois do merge
- `pnpm check` e `pnpm build`: PASS.
- `pnpm test` com MySQL (banco novo, 0001..0047): **178 arquivos / 830 passed, 0 skipped**.
- Sem MySQL: 777 passed, 53 skipped (os arquivos `*.mysql`, que contam como NOT_RUN nesse modo).
- Jornada integrada com o CRM juntado, 5 apps do zero: **A 19/19, B 9/9, C 6/6, E 4/4, V 6/6 = 44/44**.
- CI do GitHub no PR #35 (head `20a5700`): "Typecheck, tests, build e bundle budget" **success** e "E2E autenticado em MySQL descartável" **success**.

### Continua aberto
- Teste intermitente não identificado (ver addendum anterior).
- `CRM_MANAGER_ROLE` (gerente = admin).
- Migration real (0044..0047) e deploy: **HARD GATE**, não feitos.
- Relationship (suite) não lista casos ENDED.
