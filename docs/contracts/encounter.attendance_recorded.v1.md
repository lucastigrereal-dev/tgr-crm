# Contrato `encounter.attendance_recorded.v1` (Sales Command emite, CRM recebe)

Status: **receptor pronto no CRM, desligado por flag; emissor ainda não existe no Sales** (C1). Dono do contrato: tgr-commercial-suite (PR #142), seção `attendance` de `shared/contracts/consumers.lock.json` (hash `c66f9ee9...4b54097`). O CRM publica a seção idêntica à fixture da Suite em `shared/contracts/attendanceSection.ts` / `tgr-events.snapshot.json`. Mudou o contrato = muda na Suite primeiro (ordem Suite -> CRM -> re-pin).

## Rota e autenticação

- `POST /api/integrations/sales-command/encounter-outcome`, corpo JSON. Um evento por atendimento encerrado, qualquer desfecho (`SALE_CONFIRMED`, `NO_SALE`, `CAIU_EM_MESA`, `NT`).
- **Desligada por padrão**: `ATTENDANCE_RECEIVER_ENABLED=false` (flag nova; nenhuma flag existente mudou). Desligada, ou sem chave configurada, responde 404 como se a rota não existisse, mesmo com a chave certa.
- `Authorization: Bearer <SALES_COMMAND_INTEGRATION_KEY>`, comparação em tempo constante, validada antes de olhar o corpo. O corpo nunca é registrado em log.
- **Depende de migration**: `migrations/proposed/PROPOSED_0079_couple_registry_attendance.sql` (PROPOSTA, não aplicada, fora do journal). Só `CREATE TABLE IF NOT EXISTS` de `couple_registry` e `attendance_records`. Ligar a flag antes do GO e da migration = 503 em todo evento. Rollback: `DROP TABLE attendance_records; DROP TABLE couple_registry;`.

## Respostas

| Status | Quando |
| --- | --- |
| 201 | aceito |
| 200 | replay idempotente (mesmo `eventId`, mesmo corpo) |
| 400 `INVALID_EVENT` | corpo fora do schema estrito, faixa 2000..2037, `eventId` diferente do derivado de `(encounterId, revision)`, `reasonCode` com `SALE_CONFIRMED` |
| 401 | chave ausente ou errada |
| 404 | flag desligada ou sem chave configurada |
| 409 `EVENT_ID_CONFLICT` | mesmo `eventId`, corpo diferente |
| 422 `UNKNOWN_PROJECT` | nenhum resort do CRM com `resorts.externalKey = project.externalKey` (o receptor NÃO cria resort) |
| 503 `EVENT_PROCESSING_FAILED` | falha transitória; o Sales tenta de novo |

## Registro canônico do casal

- `couple_registry`: uma linha por `(resort do projeto, coupleId do Sales)`. Guarda `coupleCode`, nomes, **telefone só em dígitos** (o Sales manda texto livre; o CRM deriva os dígitos e não recusa formato) e o último atendimento (`lastEncounterId`, `lastRevision`, `lastOutcome`, `lastReasonCode`, `lastClosedAt`, `encountersCount`).
- `attendance_records`: uma linha por evento (`eventId` único; `(encounterId, revision)` único), sem nome nem telefone. Só adiciona.
- Estado "último": dentro do mesmo atendimento vale a maior `revision` (correção); entre atendimentos vale o de `closedAt` mais recente. Evento atrasado entra no histórico e não regride o estado. Nome/telefone ausentes no evento mais novo não apagam o que já existe.
- **Não toca** `customers`, `capture_records`, contratos nem `resorts`. Casar o casal com cliente existente (por telefone) é decisão futura; `phoneDigits` está indexado para isso.
- PII: nome e telefone só em `couple_registry`. Resposta, log e auditoria (`attendance_received`) carregam apenas `eventId`, desfecho e revisão.

## Provas

`server/attendanceReceiver.test.ts` (todos os `valid`/`invalid` da seção publicada, flag desligada em `.env.example`/compose/env) e `server/attendanceReceiver.mysql.test.ts` (rota HTTP real: 404/401/400, projeto desconhecido, replay, conflito, correção, atendimento atrasado, corrida do mesmo `eventId` e de casal novo). Re-pin (`crm-pair.sha`, extra-lock, remoção de `suiteAhead`) é feito na Suite depois deste PR.
