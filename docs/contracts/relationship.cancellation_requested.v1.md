# relationship.cancellation_requested.v1 (Relationship → CRM)

Status: **PROPOSTA de contrato, receptor pronto no CRM (M-A09-01a), flag OFF.** Receptor antes do emissor: o Relationship só pode emitir depois do receptor provado (M-A09-01b, thread da Suite). Não entra em `shared/contracts/tgr-events.snapshot.json` (entrada, não saída do CRM).

Decisão D3 (Lucas, 25/10): o cancelamento nasce no Relationship; o CRM decide. O pedido **não cria distrato, não aprova e não libera a cota**. A fração só volta no distrato **executado** (`executeCancellation`), definição ratificada em 25/10.

## Rotas (RELATIONSHIP_CANCELLATION_INBOX_ENABLED=true + RELATIONSHIP_INBOUND_KEY; senão 404)
- `POST /api/integrations/relationship/cancellation-request` — `Authorization: Bearer <chave>`.
- `GET  /api/integrations/relationship/cancellation-request/:protocol` — consulta o estado (mesma chave).

## Corpo (strict, sem texto livre, sem dado pessoal)
```json
{ "eventId": "rel-…", "requestId": "req-…", "contractId": 123, "reasonCode": "customer_request", "actor": "rel-user-1", "requestedAt": "2026-10-25T10:00:00.000Z", "source": "relationship" }
```
`reasonCode`: `customer_request | rescue_failed | payment_default | other`. `contractId` é o id do CRM (o mesmo de `crm.contract.*.v1`).

## Respostas
| Código | Significado |
|---|---|
| 201 | Gravado. Corpo: `{accepted:true, replay:false, eventId, protocol}`. O `protocol` persistido é o ACK. |
| 200 | Replay (mesmo eventId ou requestId, mesmo conteúdo): devolve o MESMO protocolo. |
| 400 `INVALID_EVENT` | Corpo fora do contrato. Terminal. |
| 401 | Chave ausente/errada (antes de ler o corpo). |
| 404 | Flag desligada, sem chave configurada, ou protocolo desconhecido. |
| 409 `EVENT_ID_CONFLICT` | eventId/requestId já usado com outro conteúdo. Terminal. |
| 422 `UNKNOWN_CONTRACT` / `CONTRACT_ALREADY_CANCELLED` | Regra de domínio, não reenviar. |
| 503 | Reenviar com o mesmo eventId. |

## Estado do protocolo (GET)
`received` (gravado, sem distrato) → `under_review` (distrato aberto no CRM) → `approved` | `rejected` → `executed` (distrato executado; cota liberada) · `withdrawn`. Resposta: `{protocol, contractId, status, receivedAt}`.

Pedido repetido de um contrato com distrato já aberto liga ao existente e **não duplica** (`contracts.openCancellationFromInbox`, ação da equipe do CRM).

Migration: `migrations/proposed/PROPOSED_0090_cancellation_request_inbox.sql` (aditiva, só banco descartável até GO + backup).
