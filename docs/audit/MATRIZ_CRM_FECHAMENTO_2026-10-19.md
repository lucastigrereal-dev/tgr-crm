# Fechamento do CRM: matriz, revisões e provas (2026-10-19)

Base: `main` fed7790 (PR #77 já integrado). Ramo `claude/fechamento-crm`, quatro commits de código/contrato abaixo. SHAs citados são só de commits que existem neste ramo; a execução de CI do SHA final consta no corpo do PR (o SHA deste arquivo não pode se citar).

Regras mantidas: nada em banco real; migração só em MySQL descartável; nenhum teste desligado; só dado sintético; comissão positiva TRAVADA; endpoint do NQ desligado por padrão; o CRM não vira dono de dado de outro sistema; regra de empresa vira configuração com padrão.

## Itens

| Item | Estado | Commit | Prova local (MySQL 8.0 descartável) | O que NÃO está provado |
| --- | --- | --- | --- | --- |
| CRM-A27 causa da falha de 7110fb9 | CAUSA REGISTRADA e corrigida | d694187 | `installmentSettlementOutbox.mysql` 6/6 (deadlock determinístico: falha sem a correção, passa com ela) | flakiness de outros testes que não apareceram |
| CRM-A22 leitura do NQ | RELIDO NO CÓDIGO e endurecido | d694187 | `nqReadEndpoint` unit + `nqReadEndpoint.mysql` 3/3 | endpoint ligado em produção (continua desligado; aceite do Lucas) |
| CRM-A18/A30 LGPD (aviso v4, prazos, exclusão) | IMPLEMENTADO, gate humano segue aberto | f6084e5 | `captureSheetLgpd.unit` 16, `captureErasure.mysql` 6 | revisão jurídica humana, razão social/CNPJ/encarregado reais, cópias em outros sistemas |
| INT-22 rollback 0061-0066 | PROVADO | f6084e5 | `migrationRollback.mysql` 3 (sobe-desce-sobe-desce e estado parcial) | rollback em banco com dado real |
| CRM-A07 blob órfão | IMPLEMENTADO desligado (só storage local) | a63aafc | `orphanBlobSweep.mysql` 2 | storage remoto Forge/S3 (fora do escopo, documentado) |
| CRM-A25 reenviar recusado | IMPLEMENTADO | a63aafc | `integrationResend.mysql` 2, `financialBridgeStarvation.mysql` 7 | reenvio contra um Financial/Relationship reais |
| CRM-A21/INT-10 contrato dos tempos | CONTRATO + FIXTURE + teste CRM | b746e56 | `encounterTimesContract` 23 unit, `encounterTimesContract.mysql` 5 | emissor do Sales (não existe) e ponta a ponta |
| CRM-A12 aditivo não monetário | SÓ ESPECIFICAÇÃO (ADR-012) | b746e56 | n/a | implementação: depende de decisão de produto e jurídico |

## CRM-A27: causa da falha do push em 7110fb9 (run 39055499278)

O PR #72 estava verde e o push na `main` falhou no job MySQL. A causa é `ER_LOCK_DEADLOCK` (1213) em `insert into sales_commissions` dentro da transação do webhook do Asaas (`server/paymentGatewayWebhook.ts`): duas transações concorrentes sobre a mesma baixa tomam locks em ordem oposta, o MySQL escolhe uma vítima. Os outros caminhos de baixa já usavam `withDeadlockRetry`; este não. Correção: a transação inteira roda dentro de `withDeadlockRetry` e o estado local (`installmentPaid`) é zerado a cada tentativa. O teste determinístico força o deadlock com gatilho e tabela MEMORY de marcação (sem depender de temporização) e prova as duas pontas: sem o retry falha, com o retry passa e grava uma única comissão/baixa. Nenhum teste foi desligado. A cota de Actions limita novos pushes, então a confirmação em CI do novo SHA fica no PR.

## Revisão de código e de segurança

Método: o skill `/security-review` recusou rodar (diretório de trabalho não era repositório git); a revisão foi feita manualmente, lendo o código, e isso é dito aqui para não parecer o skill. Foco: ficha/LGPD 0063, `nqReadEndpoint.ts`, `encounterTimesReceiver.ts`, autenticação/cookies, upload de documento, webhooks Clicksign/Asaas.

| Achado | Gravidade | Estado |
| --- | --- | --- |
| Webhook do Asaas sem retry de deadlock (causa do CRM-A27) | média (disponibilidade, pagamento perdido até o reenvio) | corrigido em d694187 com teste |
| NQ: o campo `detail` de critério podia carregar texto livre da ficha | média (vazamento de dado pessoal pela leitura) | corrigido em d694187: lista permitida de textos fixos e texto genérico para o resto; 2 testes |
| Reenvio de recibo financeiro não verificava se o evento existe | baixa | corrigido em a63aafc (verificação + teste com id inexistente) |
| Receptor dos tempos: chave antes do corpo, comparação por hash em tempo constante, corpo nunca em log, esquema estrito, faixa de data do MySQL | sem achado | provado pelos testes do contrato |
| Exclusão da ficha: só admin/finance registra, só administração cumpre, confirmação por código, trilha | sem achado | provado em `captureErasure.mysql` |

CRM-A22 relido no código: a rota responde 404 com a flag desligada ou sem chave configurada, 401 sem a chave certa (comparação `timingSafeEqual` sobre SHA-256, mesma técnica do receptor), 404 para código inválido/desconhecido, e o corpo é montado só de campos calculados do NQ (testado que CPF, telefone, nome, renda e texto livre não aparecem). Continua desligada por padrão.

Não coberto pela revisão manual: varredura de dependências, teste de intrusão, revisão do fluxo Clicksign além das provas existentes de HMAC.

## LGPD (CRM-A18/A30) e exclusão

- Aviso v4 vem de configuração: razão social, CNPJ e encarregado em branco por padrão; enquanto faltarem, a ficha mostra o alerta "preencher antes de casal real" (`privacyNoticeStatus`).
- Prazos como configuração com padrão: arquivamento da ficha de não comprador e guarda do papel; `room_visibility_days=0` permanece.
- Exclusão: registro do pedido, confirmação digitando o código do casal, recusa com justificativa. Cumprida, ficam nome, CPF, código e datas da ficha e a data do brinde gravada no pedido; o resto das fichas do cliente e do cadastro é limpo. Cliente com contrato, reserva, documento anexado, lista de espera ou ficha VENDEU é recusado (guarda legal pede decisão humana). Cópias no Sales Command, Relationship e Financial NÃO são tocadas e nenhum evento é emitido: a trilha do pedido é a prova para quem for replicar.

### Achados automáticos do PR #78 (corrigidos no commit seguinte)

- P1 cópias secundárias: a exclusão agora higieniza, na mesma transação, o `beforeSnapshot` de importação CSV (linha inteira do cliente), o payload de eventos de domínio do cliente e das fichas (cidade, UF, origem, motivo) e o motivo de cancelamento de voucher na trilha. Auditoria e `domain_events` já entregues a outros sistemas não são recolhidos (o CRM não é dono dessas cópias).
- P1 guarda central: `server/customerAnonymization.ts` (`assertCustomerNotAnonymized`, com trava da linha) é aplicada em `customers.update`, `customers.addInteraction`, `customers.uploadDocument`, `customerContacts.add`, `captures.create` (cliente por id ou casado por CPF/e-mail/telefone) e na importação CSV (linha que casa o CPF retido é recusada; o desfazer da importação nunca restaura cliente anonimizado). Não coberto por teste: o `undoLast` da importação (usa o último lote global, inseguro de exercitar em banco compartilhado).
- P2 um pedido aberto por cliente: o registro trava a linha do cliente e checa pedido aberto por `customerId`; sem índice único parcial (o MySQL não tem; a trava de linha serializa).
- Prova: `captureErasure.mysql` passou de 6 para 9 testes; com a guarda e a higienização neutralizadas, os 2 testes novos falham.

### Revisão formal do #78 (2 médias, 1 baixa) e receptor dos tempos

- Média 1: `findCaptureOrThrow` (captures) e `captureSheet.recordNt` recusam ficha anonimizada (PRECONDITION_FAILED); todos os updates de ficha em `captures` filtram `anonymizedAt IS NULL` (corrida vira o CONFLICT já existente quando 0 linhas).
- Média 2: `assertCustomerNotAnonymized` (com trava) em `operations.createTask`, `sales.createOpportunity`/`updateOpportunity` (cliente atual e novo) e `vouchers.issue`/`redeem`/`cancel`.
- Baixa: a limpeza de eventos virou lista de PERMISSÃO (só ids, estados e contadores) e cobre cliente, ficha, oportunidade e interação; chave nova ou de texto livre some por padrão.
- Receptor `encounter.times_recorded.v1`: a revisão achou que ele NÃO tinha flag própria (ligava com a chave da ponte Sales, que já existe). Agora `ENCOUNTER_TIMES_RECEIVER_ENABLED=false` por padrão: 404 mesmo com a chave certa (teste MySQL). Sem PII: só `coupleCode`, instantes e um booleano; o log tem só `eventId` e código da recusa; o corpo nunca é registrado. Não prova a segurança do emissor do Sales (não existe).
- Provas: `captureErasure.mysql` 11 testes; com as guardas neutralizadas os testes de guarda falham.

## CRM-A07 e CRM-A25

- Varredura de órfãos: lista o diretório do storage local e apaga o que nenhuma linha de documento referencia, com idade mínima. `ORPHAN_BLOB_SWEEP_ENABLED=false` e `ORPHAN_BLOB_SWEEP_DELETE=false` por padrão (ligar a varredura sem a exclusão só relata). Forge/S3 não é varrido: sem listagem segura aqui, fica manual.
- Reenviar: volta o recibo recusado à fila; a ponte relê a partir daquele evento (janela de rewind em memória); chave de trilha `resend-request:<id>` impede duplo clique; só o papel administrativo.

## Suíte local (MySQL 8.0.46 descartável, banco novo com `drizzle-kit migrate` 0001 a 0066)

- `pnpm check` (tsc): sem erros.
- `pnpm test`: 180 arquivos passaram, 41 pulados (os `.mysql.test.ts` sem URL); 914 testes passaram, 228 pulados.
- `.mysql.test.ts` (`--pool=forks`, como no CI): 41 arquivos, 228 testes, todos passaram (após as correções dos achados do #78).
- `pnpm build` e orçamento de bundle: app 151,3 KB (limite 450), Excel 264,4 (300), PDF 123,4 (150).
- NOT_RUN localmente: E2E de navegador (Playwright). `nqReadEndpoint.mysql` usa CPF fixo e falha em segunda execução num banco reaproveitado; no CI o banco é novo por execução (não alterei esse teste).
