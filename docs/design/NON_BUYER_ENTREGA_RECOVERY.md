# Entrega de não-comprador ao Recovery (F2.1, fatia 5), 23/10/2026

Estado: PROPOSTA de contrato + implementação atrás de `NON_BUYER_DELIVERY_ENABLED=false`. Nada ligado, nada homologado, migration 0089 só PROPOSTA. A Suite é dona do contrato (Suite -> CRM -> re-pin): este documento e a fixture `docs/contracts/fixtures/crm.non_buyer.v1.fixtures.json` NÃO entram em `consumers.lock.json` nem em `tgr-events.snapshot.json`, e nenhuma fixture publicada foi alterada.

## Fluxo
1. A transição de elegibilidade (fatias 3/4, `RECOVERY_ELIGIBILITY_ENABLED`) já grava, na mesma transação, o evento INTERNO sem PII `non_buyer.eligible` / `non_buyer.eligibility_revoked` com `eventId = crm-nb-<captureId>-<eligible|revoked>-<seq>`.
2. A bomba (`server/nonBuyerDelivery.ts`, job de 30 s) descobre eventos sem linha em `non_buyer_deliveries` (PROPOSTA 0089), um registro por `eventId`, sem PII.
3. Por ficha, em ordem de `seq`: só o estado vigente vale (evento com `seq` abaixo da projeção = `superseded`, não enviado).
4. Elegível: REVALIDAÇÃO NA ENTREGA. O predicado é recalculado com o opt-out lido; se o casal foi anonimizado, fez opt-out, tem exclusão pendente ou comprou, NÃO envia (`suppressed/revalidated_ineligible`) e a reavaliação emite o revogado.
5. Revogado só é enviado se um elegível da ficha foi entregue (`never_delivered` caso contrário): o Recovery não recebe revogação de quem nunca recebeu.
6. Concorrência: cada linha é reivindicada por lease (compare-and-set em `nextAttemptAt`) antes de ser processada; settle/retry só valem se a linha continua sendo do worker. Revogado espera (sem gastar tentativa) enquanto houver elegível anterior da ficha ainda pendente. O corpo é validado contra o contrato antes do POST; se violar, a linha vira `rejected/LOCAL_CONTRACT_VIOLATION` sem envio.
7. Corpo montado no envio. Nome e telefone vêm do cliente naquele instante e vão SÓ no corpo HTTP (nunca em `domain_events`, no livro nem em log; log só tem eventId e status).

## Contrato (v1, aditivo)
`POST {RECOVERY_NON_BUYER_ENDPOINT}/non-buyer/eligible` e `/non-buyer/eligibility-revoked`; `Authorization: Bearer <RECOVERY_NON_BUYER_KEY>` (chave própria); `idempotency-key: <eventId>`.

Elegível (`crm.non_buyer.eligible.v1`): `eventId`, `source:"crm"`, `occurredAt`, `project{externalKey,name,timezone}`, `coupleCode`, `coupleId` (opaco: `crm-capture-<id>`), `encounterDate` (YYYY-MM-DD no fuso do projeto), `dedupeKey`, `eligibleAt`, `lastEncounterAt`, `branch` (`closed|no_tour`), `reasonCode` (código de `capture_motives`, nunca texto livre; nulo no ramo closed), `consentVersion` (nulo até a decisão do ciente), `channels[]` (vazio até a decisão de canais), `contact{name,phone}`. Nunca: CPF, renda, notas, documentos, complemento livre.

Revogado (`crm.non_buyer.eligibility_revoked.v1`): `eventId`, `source`, `coupleCode`, `encounterDate`, `dedupeKey`, `revokedAt`, `reason` (`opt_out|anonymized|erasure|sale_in_progress|attendance_not_finished`). Sem PII. Acrescenta `attendance_not_finished` à lista do desenho §4.2 (é um motivo que o CRM já produz); a Suite decide se mantém.

### Chave de dedupe do Recovery
`dedupeKey = coupleCode + ":" + encounterDate`. O mesmo casal no mesmo dia de atendimento é UM caso no Recovery, mesmo que o CRM reemita (novo `seq`/`eventId` depois de revogar e voltar a ser elegível). `encounterDate` = data civil, no fuso do projeto (`financial_project_map.timezone` se houver, senão `America/Recife`), de `presentationEndedAt` (ramo closed) ou `ntRecordedAt` (ramo no_tour), com `checkedInAt`/`occurredAt` só como reserva. Elegível e revogado da mesma ficha carregam a MESMA `dedupeKey`: o livro grava a identidade ENTREGUE do elegível (`coupleCode`, `encounterDate`, `dedupeKey`; código pseudônimo, sem nome/telefone) e o revogado a repete, mesmo se o admin trocar o `coupleCode` ou o fuso do projeto depois da entrega (o Recovery só casa o opt-out pela chave que recebeu).

### Respostas e reentrega
2xx = entregue (200 = replay). 4xx com `{code: ^[A-Z0-9_]+$}` exceto 408/425/429 = recusa terminal (`rejected`, sem reenvio, sem DLQ silenciosa: fica no livro). Todo o resto (401/403/404/429, 5xx, rede, 4xx sem code) = nova tentativa com backoff persistido (5 s dobrando, teto 10 min), com TETO de tentativas (`NON_BUYER_DELIVERY_MAX_ATTEMPTS`, padrão 30 ≈ 4 h): esgotado, o ELEGÍVEL vira `dead` (terminal, `reason = DEAD_<motivo>`, auditoria `non_buyer_delivery_dead` + log de erro) e só o operador o retoma. O REVOGADO nunca vira `dead` (o Recovery ficaria com o casal elegível, contato indevido em opt-out/LGPD): passado o teto segue tentando no backoff máximo e o alerta `non_buyer_revocation_stuck` sai uma vez. Não há DLQ separada: o livro `non_buyer_deliveries` é a fila morta. Sem `coupleCode` ou sem projeto (`resorts.externalKey` ou mapa ativo): espera com backoff, não envia.

## Flag e configuração
`NON_BUYER_DELIVERY_ENABLED` (nasce false; compose e `.env.example`; fora da tela de flags), `RECOVERY_NON_BUYER_ENDPOINT` (https, ou http só em localhost) e `RECOVERY_NON_BUYER_KEY`. O job só inicia com a flag, `RECOVERY_ELIGIBILITY_ENABLED=true`, endpoint válido e chave.

## Pendências (fora deste PR)
- Suite -> CRM -> re-pin: publicar o contrato `crm.non_buyer.*.v1` e o receptor do Recovery; só então o CRM trava a seção.
- Precedência/dedupe no Recovery (F2.7) e abre-caso automático: continua DESLIGADO; o caso só abre por ação humana.
- Decisões do Lucas: canais autorizados e texto/versão do ciente (`channels`, `consentVersion`).
- Janela residual: entre a revalidação e o POST pode haver um opt-out/exclusão; o revogado seguinte cobre (o Recovery aplica o opt-out por casal).
