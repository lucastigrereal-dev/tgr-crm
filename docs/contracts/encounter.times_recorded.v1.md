# Contrato `encounter.times_recorded.v1` (Sales Command emite, CRM recebe)

Status: **proposto, receptor pronto e provado no CRM; emissor ainda não existe no Sales Command** (CRM-A21 / INT-10). Fixture compartilhada e versionada: `docs/contracts/fixtures/encounter.times_recorded.v1.fixtures.json`. O Sales deve provar o emissor contra o MESMO arquivo; o CRM prova o receptor em `server/encounterTimesContract.test.ts` (sem banco) e `server/encounterTimesContract.mysql.test.ts` (rota HTTP real, MySQL descartável).

## Rota e autenticação

- `POST /api/integrations/sales-command/encounter-times`, corpo JSON.
- `Authorization: Bearer <SALES_COMMAND_INTEGRATION_KEY>` (a mesma chave da ponte Sales -> CRM). Comparação em tempo constante. Sem chave configurada no CRM a rota responde 503.
- A chave é validada ANTES de olhar o corpo; o corpo nunca é registrado em log (só `eventId` e código da recusa).

## Envelope

| Campo | Regra |
| --- | --- |
| `eventId` | texto 1 a 120, único por evento (chave de idempotência) |
| `eventName` | literal `encounter.times_recorded.v1` |
| `source` | literal `sales-command` |
| `correlationId` | texto 1 a 120 |
| `occurredAt` | instante UTC ISO 8601 terminando em `Z` (com frações permitidas), entre 2000-01-01 e 2037-12-31 (faixa do `timestamp` do MySQL) |
| `coupleCode` | texto 1 a 64: o `publicCode` do casal no Sales Command = `coupleCode` da ficha no CRM |
| `times` | objeto estrito, ao menos um horário: `waitStartedAt`, `waitEndedAt`, `consultantStartedAt`, `consultantEndedAt`, `closerStartedAt`, `closerEndedAt`, `endedAt` (todos instantes UTC com `Z`) e `consultantDispensed` (booleano) |

Campo desconhecido na raiz ou em `times` é recusado (esquema estrito). Fim antes do início na mesma etapa, ou `endedAt` antes de qualquer etapa, é recusado. Deslocamento de fuso (`-03:00`) é recusado: o contrato é sempre UTC com `Z`.

## Respostas e o que o emissor faz

| Status | Corpo | Significado | Ação do emissor |
| --- | --- | --- | --- |
| 201 | `{accepted:true, replay:false}` | gravado | marcar entregue |
| 200 | `{accepted:true, replay:true}` | mesmo `eventId` e mesmo conteúdo já gravados | marcar entregue |
| 400 | `{error}` | corpo fora do contrato | parar, corrigir o emissor (não reenviar igual) |
| 401 | `{error}` | chave ausente ou errada | parar e avisar a operação |
| 409 | `{code:"EVENT_ID_CONFLICT"}` | `eventId` já existe com conteúdo diferente | nunca reutilizar `eventId` com outro conteúdo; gerar `eventId` novo |
| 422 | `{code:"UNKNOWN_COUPLE_CODE"}` | o CRM não conhece o casal | parar de reenviar e revisar o código (não é erro de rede) |
| 503 | `{code:"EVENT_PROCESSING_FAILED"}` ou `{error}` | banco indisponível, chave não configurada ou falha interna | reenviar com recuo exponencial, mesmo `eventId` |

## Semântica

- **Só adiciona.** Cada `eventId` novo vira uma linha em `encounter_time_records`; nenhuma ficha é alterada. Uma correção de horários é um evento novo (outro `eventId`) para o mesmo casal; a leitura usa o mais recente por `occurredAt`.
- **Idempotência.** O hash do conteúdo ignora a ordem das chaves do JSON. Corrida entre duas entregas do mesmo evento é resolvida pela chave única (o perdedor responde replay). Deadlock do MySQL é repetido internamente.
- **Trilha.** Cada gravação deixa `audit:encounter-times:<eventId>` em `audit_logs`.
- **Versionamento.** Mudança incompatível = `encounter.times_recorded.v2` com rota/arquivo de fixture próprios; o v1 nunca é editado de forma incompatível. Campo novo opcional também exige v2 enquanto o esquema for estrito.

## Decisão pendente (Lucas)

Qual relógio marca o início da espera: o **check-in na recepção** ou o instante em que a **ficha fica pronta**. Enquanto isso o CRM apenas guarda os horários que o Sales manda; não calcula nem interpreta o relógio. Quando decidido, é regra do emissor (Sales), não muda este contrato.

## Provas

- Receptor + fixture sem banco: `server/encounterTimesContract.test.ts` (23 testes).
- Rota HTTP + MySQL: `server/encounterTimesContract.mysql.test.ts` (5 testes) e `server/encounterTimesReceiver.mysql.test.ts` (5 testes).
- NÃO provado aqui: o emissor do Sales Command (não existe) e o fluxo ponta a ponta entre os dois sistemas.
