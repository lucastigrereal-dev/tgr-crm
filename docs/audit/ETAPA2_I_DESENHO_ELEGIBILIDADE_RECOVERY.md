# ETAPA 2 / C2-C3: desenho da elegibilidade de não-comprador para o Recovery, opt-out e outbox (21/10/2026)

Somente desenho. Nenhum código, migration ou flag nesta entrega. Base: `origin/main` 2e2cde5, `GAP_ETAPA2_CRM.md` item 9 (PR-I1/I2/I3) e `GAP_ETAPA2_SUITE.md` itens 1, 2 e 4.

## 1. Decisões do Lucas (21/10/2026) que mandam aqui
- A FICHA é o consentimento de contato do Recovery (substitui a pergunta "quem coleta a autorização").
- Relationship só abre após venda validada (fora deste desenho).
- CAIU EM MESA não abre Recovery sozinho (já atendido no CRM: `captures.recordCommercialOutcome` só grava fato). Só entra no Recovery quem passa pela elegibilidade abaixo.
- Canais autorizados: AINDA NÃO DITOS (pergunta 1 abaixo).

## 2. Fatos do CRM que condicionam (verificados no código)
1. **Não existe fato de "ciente" gravado.** `capture_sheet_prints` guarda impressão, coleta (`collectedAt`) e destruição do papel; `captureSheetDomain.ts` imprime a faixa do "ciente" (aviso v4, `PRIVACY_NOTICE_VERSION`) mas nada registra que o casal deu o ciente, nem com qual versão do texto. O código evita de propósito a palavra "consentimento" ("em sala de vendas o campo é ciente").
2. O aviso v4 ainda traz `[PREENCHER ANTES DE CASAL REAL]` (razão social, CNPJ, encarregado, canal, prazo). Não vale para casal real até ser completado/aprovado.
3. O CRM não tem nenhuma saída para o Recovery (`bridgeConfig.ts` só tem relationship, salesCancellation e financial). O Recovery só aceita eventos `source: "sales-command"` e hoje devolve `recovery.opted_out.v1` só ao Sales.
4. Sinais de atendimento e desfecho já existem na ficha: `capture_records.presentationStatus`, `presentationStartedAt/EndedAt`, `commercialOutcome` (`vendeu | caiu_em_mesa`), `commercialOutcomeMotiveId`, `ntKind`, `ntMotiveId` (catálogo `capture_motives`). Anonimização: `customers.anonymizedAt` e `capture_records.anonymizedAt` (`customerAnonymization.ts`, `captureErasure.ts`).
5. Padrão de ponte existente a reaproveitar: evento interno via `txEvent` na mesma transação, bomba com cursor e recibo por `audit_logs.idempotencyKey` (`relationshipBridge.ts`), par endpoint+chave obrigatório, DLQ visível, corpo montado por whitelist.

## 3. Modelo proposto (PROPOSTA, nada aplicado)
### 3.1 Fato do ciente (pré-requisito de tudo)
Gravar, no ato da coleta da ficha assinada (já existe o momento `collectedAt`), um fato imutável append-only: `capture_contact_acknowledgements` (captureId, customerId, `noticeVersion`, `acknowledgedAt`, `recordedByUserId`, `channelsAcknowledged` (conjunto; vazio até a pergunta 1 ser respondida), `sourceRef` opaco). Sem texto livre, sem cópia do documento. O fato vale por `noticeVersion`: aviso incompleto (`privacyNoticeStatus(...).complete === false`) NÃO gera fato elegível.
### 3.2 Opt-out
`customer_contact_optouts` append-only (customerId, `optedOutAt`, `source` = `crm_staff | recovery | owner_request`, `eventId` de origem para idempotência, `reasonCode` opcional). Opt-out tem efeito imediato e vence qualquer ciente anterior ou posterior até ser revertido por novo ciente posterior explícito (decisão do titular, ver 6.3). Pedido de exclusão/anonimização do casal também revoga.
### 3.3 Elegibilidade (função pura + consulta)
Casal é elegível quando TODAS valem:
- (a) **atendimento ENCERRADO**: ramo A = `presentationStatus = "closed"` com `presentationEndedAt` preenchido (só `captures.endPresentation` grava isso; verificado em `routers/captures.ts`: `startPresentation` já põe `presentationStatus = "presented"`, que é atendimento EM ANDAMENTO e NÃO elegível, para o Recovery não contatar o casal durante a apresentação); ramo B, separado = não-tour registrado (`presentationStatus = "no_tour"` com `ntKind` e `ntMotiveId` gravados por `captures.markNoTour`/`captureSheet.recordNt`). CAIU EM MESA entra pelo ramo A (a ficha só fica `closed` pelo encerramento) e fornece o `reasonCode`. E SEM contrato validado ativo (`sale_validations.validatedAt` nulo, ou contrato cancelado/distratado depois);
- (b) existe ciente com `noticeVersion` completa; (c) existe pelo menos um canal autorizado; (d) sem opt-out vigente; (e) `customers.anonymizedAt` e `capture_records.anonymizedAt` nulos; (f) sem exclusão pendente (`captureErasure`).

### 3.4 Transições que mudam o predicado (hooks transacionais + reconciliação durável)
O estado é DERIVADO; um evento só pode sair na mesma transação da mudança que o causa, e toda mudança de (a)-(f) tem de ter um ponto. Pontos (cada um recalcula o predicado do casal e, se mudou, grava o evento interno na MESMA transação via `txEvent`):
1. `captures.endPresentation` (ramo A) e `captures.markNoTour` / `captureSheet.recordNt` (ramo B): ciente já coletado ANTES do fim do atendimento só vira elegível aqui; sem este hook o casal nunca seria emitido.
2. Gravação do ciente na coleta da ficha (`captureSheet`, `capture_sheet_prints.collectedAt`): atendimento já encerrado antes da coleta vira elegível aqui.
3. `captures.recordCommercialOutcome` (caiu em mesa) só atualiza o `reasonCode` do evento seguinte; não muda o predicado sozinho.
4. Opt-out (CRM ou receptor `recovery.opted_out.v1`) e anonimização/exclusão (`captureErasure`, `customerAnonymization`): revogam.
5. `saleValidationService.validateSale`: venda validada REVOGA (`reason = sale_validated`, promessa da §4.2).
6. Cancelamento/distrato posterior de contrato validado (`contract.status.updated` para cancelado, distrato executado): se o casal não tem mais venda validada ativa, REAVALIA e pode voltar a ser elegível (novo evento `eligible` com sequência seguinte).
7. Aviso passa de incompleto para completo (ou muda `noticeVersion`): reavalia todos os casais com ciente da versão anterior (job de lote).
**Rede de segurança durável**: projeção `non_buyer_eligibility_state` (captureId, `eligible` 0/1, `seq`, `lastEmittedAt`) e um job de reconciliação idempotente (cursor por captureId) que recalcula o predicado de todos os casais, compara com a projeção e emite apenas a DIFERENÇA (`eventId` = `crm-nb-<captureId>-<eligible|revoked>-<seq>`). Qualquer transição esquecida pelos hooks é pega na rodada seguinte; os hooks dão baixa latência, a reconciliação dá garantia. Teste obrigatório: para cada ponto acima, a transição emite exatamente um evento, e desligar os hooks na fixture ainda converge pela reconciliação.

## 4. Contratos (novos, aditivos, `.v1`)
### 4.1 CRM -> Recovery (outbox): `crm.non_buyer.eligible.v1`
Corpo mínimo por whitelist: `eventId` (`crm-nb-<captureId>-eligible-<seq>`), `source:"crm"`, `occurredAt`, `project{externalKey,name,timezone}`, `coupleCode` (e `coupleId` opaco do CRM), `eligibleAt`, `consentVersion`, `channels[]`, `reasonCode` (do catálogo `capture_motives`: motivo de NT ou de CAIU EM MESA, nunca texto livre), `lastEncounterAt`. NUNCA: CPF, renda, notas, documentos. Nome e telefone: o Recovery precisa para contatar; a proposta é enviá-los só no corpo da entrega ao canal autorizado e NUNCA gravá-los em `domain_events` (padrão `no_sale` do Sales: PII só na outbox/entrega, redigida em log). Decisão de arquitetura com a Suite pendente: alternativa é entregar só o token e o Recovery buscar contato por chamada autenticada.
### 4.2 CRM -> Recovery: `crm.non_buyer.eligibility_revoked.v1`
`eventId`, `coupleCode`, `revokedAt`, `reason` (`opt_out | anonymized | erasure | sale_validated | notice_invalid`). Sem PII. Recovery aplica o opt-out/encerramento que já existe (`recordOptOut` por casal).
### 4.3 Recovery -> CRM: `recovery.opted_out.v1` (mesmo nome, novo destinatário)
Receptor no CRM `POST /api/integrations/recovery/opt-out`: autenticação server-to-server (`timingSafeEqual`, par endpoint+chave), corpo `strictObject {eventId, coupleCode, optedOutAt, source:"recovery"}`, idempotente por `eventId` (replay = 200, mesmo `eventId` com conteúdo diferente = 409), casal desconhecido = 422 não-reenviável. Grava `customer_contact_optouts` e dispara a revogação (4.2) se havia elegibilidade. Latência: opt-out do Recovery vale no CRM no ato.
### 4.4 Quem o Recovery precisa receber e devolver
Recebe: o par acima, só de elegíveis; nunca CAIU EM MESA/NT sem ciente. Devolve: opt-out (4.3) e, para auditoria, o encerramento do caso (`recovery.converted.v1` já existe; o CRM só registra, não age em dinheiro).
## 5. Entrega, flags, testes
- Flag `RECOVERY_ELIGIBILITY_ENABLED` (padrão OFF; desligada = nenhuma elegibilidade calculada, nenhum evento, receptor 404). Chave de integração própria (`RECOVERY_INTEGRATION_*`), mesmo padrão do `nqReadEndpoint`.
- Pump de saída igual ao do Relationship (cursor em memória + recibo `crm-nb:<captureId>:<seq>`), eventos internos `non_buyer.eligible`/`non_buyer.eligibility_revoked` criados na mesma transação de cada transição da §3.4 (encerramento do atendimento, NT, coleta da ficha, opt-out, anonimização, venda validada, cancelamento) e, como rede de segurança, pelo job de reconciliação.
- Contrato travado: nova seção `recovery` em `tgr-events.snapshot.json` e `consumers.lock.json`; na Suite: `crm-contract.lock.json`, fixtures, `verify-crm-contract.mjs`, workflows e `crm-pair.sha` (Suite mergeada ANTES do CRM, regra do lock).
- Testes mínimos: elegível / não elegível por cada critério (a-f), opt-out com efeito imediato, anonimizado fora do feed, CAIU EM MESA sem ciente fora, replay idempotente (200) e conflito (409), paginação estável do feed (se houver leitura), PII ausente de `domain_events` e de logs, falha de rede não perde o evento (outbox), revogação antes e depois do caso.
- Migrations: só PROPOSTAS em `migrations/proposed/` (3.1 e 3.2); nada aplicado.
## 6. Perguntas que sobram para o Lucas (máx. 2)
1. **Canais**: quais canais a ficha autoriza para o Recovery contatar (WhatsApp, ligação, SMS, e-mail; todos ou um conjunto fixo) e se o casal pode escolher na própria ficha?
2. **Texto e escopo do ciente**: a faixa do "ciente" da ficha passa a dizer expressamente que autoriza contato de recuperação comercial (e por quanto tempo guardamos o não-comprador), e quem aprova esse texto/aviso v4 antes de qualquer casal real? Junto: depois de um opt-out, um novo ciente posterior reativa a elegibilidade ou o opt-out é definitivo?
