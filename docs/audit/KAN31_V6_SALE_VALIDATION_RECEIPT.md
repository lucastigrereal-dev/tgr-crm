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

---

## Rodada de correções da revisão (branch `kan-31/v6-review-fixes`)
Base `c8c976c` (HEAD de `kan-v6/final-goal-kywbhh`). Código em `d540610`; este bloco é o commit seguinte. Sem push, sem merge. Esta rodada SUPERA as afirmações acima sobre trigger append-only e sobre `create`/`updateStatus`.

| SHA | Correção |
|---|---|
| b11f4fc | 0044 editada no lugar SEM os 2 triggers (nunca aplicada em banco real; journal/snapshot intactos, `drizzle-kit generate` = "No schema changes"). Append-only por código: `saleValidationAppendOnly.test.ts` (nenhum update/delete Drizzle ou SQL cru; serviço só faz `insert`; 0044 sem `CREATE TRIGGER`). Teste mysql do trigger removido |
| 1c2cfd0 | Portões só contam documento da categoria do contrato (`Contrato`/`Contrato assinado`, sem caixa; cópia de RG/Comprovante/Aditivo não vale; `pickSignedDocument` idem). Novo portão `noOpenCancellation` (distrato `requested|approved`) em `missing`, rejeição auditada. `confirmPayment` trava o contrato `FOR UPDATE` na transação e re-checa status. Comissão de parcelas pagas antes da validação nasce na própria transação da validação (`releaseCommissionsForValidatedContract`, construtor único em `installmentCommissions.ts`, idempotente por parcela+papel; política incompleta => `commission.automatic.blocked`). `documentRef = contract_document:<id>` (pagamento: `null`; evidência fica em `sale_validations.paymentEvidenceRef`). Segunda validação concorrente = sucesso idempotente (sem `validation_rejected`); CONFLICT dentro da transação também grava `validation_rejected`. `concurrencyGuards.mysql.test.ts` semeia o próprio admin (antes: FK de `audit_logs` com user 1 inexistente em banco novo) |
| 7a99335 | `commission.automatic.blocked.reason` = `sale_not_validated` / `incomplete_project_policy` / `contract_not_active` conforme a causa real (baixa manual e webhook). Baixa e webhook travam o contrato antes da parcela e leem a validação já serializada (fecha a corrida com a validação final) |
| a65d334 | `contracts.create` só `draft`/`pending_signature` para qualquer papel (resto = CONFLICT `SALE_VALIDATION_REQUIRED`); `updateStatus` overdue->active só com `sale_validations.validatedAt` (vale p/ contrato importado em CSV como vencido) |
| 365715f | `imports.undoLast` recusa lote cujo contrato tem `sale_validations`/`sale_validation_events` (PRECONDITION_FAILED claro, sem FK 500) |
| 96228fd | `commissions.setStatus` approved/paid exige contrato validado e não cancelado; `commissions.record` exige validado e não cancelado (`COMMISSION_REQUIRES_VALIDATED_SALE`) |
| 2fd84dc | Motivo livre de `recordCommercialOutcome` fora do evento (`allowedPayloadFields` só `outcome`) e do resumo de auditoria; fica só nas colunas de `capture_records`. Snapshot regenerado (`export-event-contract.ts`): sem diff, o evento não está no subconjunto Financial |
| 7765489 | Bridge: recusa 4xx (exceto 408/425/429) com `code` `^[A-Z0-9_]+$` no corpo = recibo terminal na 1ª vez (código no texto do recibo) e a fila segue, para Sales Command e Financial; sem código mantém 5x + janela; 5xx/408/425/429 sempre retentam; Relationship inalterado. `buildContractStateBody`/`eventNameFor` exaustivos (`validated` e desconhecido lançam) |
| d540610 | `getValidationStatus` só admin/finance (capacidade `sale.validation.view`); card oculto para os demais e desabilita Confirmar pagamento/Validar venda em cancelado/encerrado/vencido; portão de distrato exibido |

### Comandos e resultados
Bancos descartáveis `crm_fix_<hex>_test` em `tgr-sales-v3-mysql-1` (127.0.0.1:43316), migrados do zero com `DATABASE_URL=… pnpm exec drizzle-kit migrate`, derrubados ao fim.
- `pnpm check`: PASS.
- `pnpm test -- --reporter=dot --pool=forks --poolOptions.forks.singleFork=true` SEM MySQL: 157 arquivos passed + 8 skipped / **674 passed, 45 skipped** (skips = 8 arquivos mysql).
- Mesmo comando COM `TGR_MYSQL_INTEGRATION_URL` (DB nova, `DATABASE_URL` não definida): **165 arquivos / 719 passed, 0 skipped** (8 `*.mysql.test.ts`, incl. `saleValidation.mysql.test.ts` 23 testes e `schemaDrift`).
- `concurrencyGuards.mysql.test.ts` sozinho em DB recém-migrada: 3/3 passed (com o arquivo antigo: falha de FK em `audit_logs`, comprovado).
- `pnpm build`: PASS. `drizzle-kit generate`: "No schema changes".

### Testes existentes alterados (nenhum pulado/desabilitado)
`saleValidation.test.ts` (documentos com `category`; `missing` ignora o novo portão quando aberto), `saleValidation.mysql.test.ts` (documentRef; concorrência agora exige 3 sucessos), `finance.commission-sale-validation.test.ts` e `paymentGatewayWebhook.sale-validation.test.ts` (mock com trava do contrato e leitura da validação dentro da transação), `commissionPolicySafety.test.ts` (call sites usam `commissionBlockReason`), `contracts.sale-validation-bypass.test.ts`, `rbacMatrix.test.ts` (`create(active)` saiu da tabela por capacidade: agora é CONFLICT para qualquer papel comercial, teste dedicado), `commissions.*.test.ts`, `imports.undo.test.ts`, `captures.commercial-outcome.test.ts`.

### Decisões e limitações
- `commissions.setStatus` com `contractId` nulo (comissão legada sem contrato) continua permitido: não há venda a validar; `record` já exige contrato.
- Cancelar comissão (`setStatus cancelled`) segue permitido sem venda validada (não libera dinheiro).
- Trava de contrato antes da parcela (baixa/webhook), igual ao distrato e à validação: mesma ordem contrato -> parcela, sem inversão.
- Códigos de recusa: Sales/Financial devem mandar `code` só em recusa de conteúdo; condição transitória (503 sem code) nunca vira recibo terminal.

---

## Red Team fix round (branch `kan-31/v6-redteam-fixes`, base `17d8049`)
Sem push, sem merge. 0044 editada no lugar (nunca aplicada em banco real); journal/snapshot consistentes, `drizzle-kit generate` = "No schema changes", `schemaDrift` verde.

| SHA | Correção |
|---|---|
| 7f63729 | P1: `contract_documents.signedArtifact` (boolean NOT NULL default false, na 0044). Vira true SÓ em `contracts.uploadDocument` com `signed:true` por quem tem `document.sign` (bytes via `storagePut`). `markDocumentSigned` e o e-sign (sign/document_signed/envelope_closed) nunca o setam; continuam marcando `signed` (exibição/compat), que NÃO entra mais em nenhum portão. Portões: `contractSigned` = `contracts.signedAt` OU artefato assinado da categoria do contrato; `signedDocumentStored` = artefato assinado da categoria com `storageKey`; novo `noOpenSignatureEnvelope` (envelope `draft`/`running` bloqueia, entra em `missing`); `pickSignedDocument` só devolve artefatos. `signedAt` = `contracts.signedAt` (webhook `occurred_at` no fechamento) senão `createdAt` do ARQUIVO ASSINADO (horário atestado do upload; nunca o do rascunho). Categoria normalizada (caixa, acento, `_`, `-`, espaços): `contrato_assinado` = `Contrato Assinado` = `contrato-assinado` (P3-6). UI: "Contrato assinado armazenado (arquivo assinado enviado)" + linha do novo portão; lista de documentos distingue "arquivo assinado enviado" de "assinatura confirmada (falta enviar o arquivo assinado)" |
| def7302 | P2: CSV de contratos recusa `ativo/active`, `inadimplente/overdue`, `encerrado/closed` com erro por linha (campo `status`): "Contrato ativo/legado exige decisão LEGACY_ACTIVE_BACKFILL — importe como pending_signature ou aguarde a decisão." (arquivo inteiro não grava, como qualquer erro de validação). `rascunho`/`pendente_assinatura`/`cancelado` seguem importáveis. Template da tela e guia atualizados |
| 825232c | P2: pumps Financial e Sales/Relationship (`relationshipBridge.ts` compartilhado). Cursor por id em memória que avança sobre todo evento lido + `createRetryBackoff` por evento: 5s dobrando, teto 10 min; evento em backoff sai da frente do lote e só é retentado quando vence. Antes: Financial relia sempre os mesmos 500 primeiros sem recibo (martelando e escondendo os novos); Sales/Relationship parava o cursor no 1º falho (reenvio a cada tick; 500 presos escondem o resto). Recusa codificada segue terminal na 1ª vez; regra 5x+janela inalterada. Opções de teste `now` e `batchSize` |
| 79fd99a | P3-5: `commissions.record` valida (contrato existe, não cancelado, venda validada) e insere na mesma transação, com o contrato travado `FOR UPDATE`; idempotência/dup-key tratadas dentro da transação |

### Testes
- Novos: `saleValidation.test.ts` (signedArtifact, categoria, envelope aberto), `contracts.signed-artifact.test.ts` (4: só admin+signed cria artefato; markDocumentSigned não), `eSignatureService.mysql.test.ts` (PoC: um `sign` não satisfaz os portões e `validateSale` é recusada; fechar envelope sem arquivo assinado continua recusado; após o admin subir o PDF assinado valida e `signedAt` == `occurred_at` do webhook), `csvImport.test.ts`/`imports.contracts-integrity.test.ts` (LEGACY_ACTIVE_BACKFILL), `pumpBackoff.test.ts` (6: backoff 5s/10s/20s/teto, preso não segura o novo, lote menor que os presos, recusa codificada), `financialBridgeStarvation.mysql.test.ts` (MySQL real + servidor HTTP: 3 presos com lote 2, o novo chega, retry só após o backoff), `commissions.record-integrity.test.ts` (+3: mesma transação com FOR UPDATE, cancelado/invalidado entre pré-checagem e trava).
- Alterados (nenhum pulado): `saleValidation.mysql.test.ts` (semente grava `signedArtifact`), `eSignatureService.mysql.test.ts` (asserções `signedArtifact=false` após sign/close, `signedAt`), `csvImport.test.ts` (contrato importado como `pendente_assinatura`), `relationshipBridge.test.ts`/`financialBridge.test.ts`/`saleValidatedBridge.test.ts` (cada tick de teste avança o relógio além do teto de backoff via `eagerPump`; o pump lê o lote antes dos retries para manter a ordem das leituras posicionais dos mocks).

### Comandos e resultados
Bancos descartáveis `crm_rt_<hex>_test` em `tgr-sales-v3-mysql-1` (127.0.0.1:43316), migrados do zero com `DATABASE_URL=… pnpm exec drizzle-kit migrate`, derrubados ao fim.
- `pnpm check`: PASS. `pnpm build`: PASS. `drizzle-kit generate`: "No schema changes".
- `pnpm test -- --reporter=dot --pool=forks --poolOptions.forks.singleFork=true` SEM MySQL: 159 arquivos passed + 9 skipped / **695 passed, 47 skipped** (skips = os 9 arquivos mysql).
- COM `TGR_MYSQL_INTEGRATION_URL` (DB nova, `DATABASE_URL` não definida): **168 arquivos / 742 passed, 0 skipped** (9 `*.mysql.test.ts`: os 8 anteriores + `financialBridgeStarvation.mysql.test.ts`).

### E-sign: o que faz agora
`clicksign.ts` NÃO tem download do documento assinado (só criar envelope, adicionar documento/signatário/requisitos, ativar, notificar, consultar envelope, verificar HMAC). Nenhuma API externa foi inventada: não há auto-download. O gerente (admin, `document.sign`) deve baixar o PDF assinado no provedor e enviá-lo em `contracts.uploadDocument` com `signed:true` (categoria do contrato). O webhook `envelope_closed` marca `contracts.signedAt` (= `occurred_at`) e `signed` do rascunho (exibição), mas nunca `signedArtifact`; com envelope `draft`/`running` a validação fica bloqueada (`noOpenSignatureEnvelope`).

### Limitações
- Contratos antigos com `signed=true` sem arquivo assinado não têm `signedArtifact`: precisam do upload do assinado para validar.
- Backoff e cursor dos pumps são em memória (zeram no restart; releitura é segura, entrega idempotente por recibo). Com mais eventos presos que o lote, cada ciclo de varredura reabre os presos só quando o backoff vence.
- A trava `FOR UPDATE` de `commissions.record` é provada por mock de ordem (begin, lock, insert, commit), não por teste de concorrência em MySQL.
- A importação CSV de contratos legados ativos fica bloqueada até a decisão `LEGACY_ACTIVE_BACKFILL`.
