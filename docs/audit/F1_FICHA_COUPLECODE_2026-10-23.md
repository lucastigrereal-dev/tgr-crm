# F1.10, F1.6, F1.4, F1.3: ficha, código do casal e reprocesso (23/10/2026)

Nada aqui foi homologado. Tudo novo nasce DESLIGADO. Provas: testes em MySQL descartável (`*.mysql.test.ts`) e unitários; nenhum banco real, nenhum deploy.

## O que mudou

| Pacote | Estado antes | Mudança | Prova |
| --- | --- | --- | --- |
| F1.10 ficha da ponte de venda | `sale.ready_for_contract` criava a ficha com `coupleCode` NULL; não abria por `/ficha?codigo=`; a recepção abria outra ficha do mesmo casal | O corpo da venda aceita `coupleCode` OPCIONAL (1..64). Quando vem: a ficha nasce com o código; se já existe ficha com o código, a venda se junta a ela (cliente e ficha únicos): a oportunidade aberta da ficha é REAPROVEITADA como a venda ganha (uma só oportunidade por casal), de modo que contrato -> proposta -> oportunidade -> ficha continua fechando o join usado por `revenueQualitySync`, contratos e financeiro; ficha sem `resortId` recebe o do projeto da venda (resort diferente: mantido e registrado em log); oportunidade perdida da ficha passa a apontar para a da venda; oportunidade já ganha (outra venda) não é tomada. Ficha anonimizada com o código: não reaproveita, não grava o código, a venda segue. Com `SALE_BRIDGE_REUSE_CAPTURE_ENABLED=true`: reaproveita a ÚNICA ficha recente (36 h) da recepção do mesmo cliente, sem oportunidade OU com oportunidade ainda aberta (a recepção cria uma por padrão; ficha sem local de captação também vale); dois candidatos = ambíguo, cria a da venda | `server/saleBridgeCoupleCode.mysql.test.ts` |
| F1.6 ficha sem data | #117 já tirou o passante de "agendado" nos indicadores; a entrada aceitava ficha sem data e sem marca | Com `CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY=true`, `captures.create` exige data da visita OU "passante" explícito (a tela avisa antes). Fila mostra "Passante" e conta passantes à parte | `server/captureVisitRule.test.ts`, `server/receptionQueueNullDate.mysql.test.ts` (bloco F1.6) |
| F1.4 vínculo / alerta | Casal sem ficha virava 422 só no log; nada no painel | Cada 422 `UNKNOWN_COUPLE_CODE` da rota dos tempos vira uma linha de auditoria (uma por `eventId`); `captureSheet.unlinked` (com o mesmo recorte de vista da sala da lista da ficha para quem não abre ficha arquivada) junta "códigos do Sales sem ficha" e "fichas que chegaram sem código"; painel na Sala de vendas com ligação em um clique (admin/vendedor, com confirmação); `/ficha?captura=ID&codigo=CP-…` abre a ligação com o código sugerido | `server/unlinkedCouples.mysql.test.ts`, `server/unlinkedCouplesPanelUi.test.ts` |
| F1.3 reprocesso | O receptor já procura a ficha a cada chamada | TESTE DE REGRESSÃO, não correção: nenhuma mudança no receptor (o comportamento já existia). O teste prova "casal chega sem ficha, ficha criada na hora, tempos entram na próxima tentativa" (422, depois 201 com o MESMO `eventId`, depois replay 200). Não mede a janela de retentativa do Sales (#154), e não prova o '< 15 min' do plano | `server/unlinkedCouples.mysql.test.ts` |

## Contratos e re-pin da Suite

- `server/encounterTimesReceiver.ts` e `server/nqReadEndpoint.ts`: NÃO foram alterados (hash em `scripts/crm-extra-contracts.lock.json` da Suite continua válido). A observação do 422 é um middleware à parte (`server/unlinkedCouples.ts`).
- Seções do snapshot `shared/contracts/tgr-events.snapshot.json` e `consumers.lock.json`: NÃO mudaram.
- Corpo de entrada `sale.ready_for_contract.v1` (Sales -> CRM): ganhou `coupleCode` OPCIONAL. É compatível (o Sales atual não envia). Para o código chegar, falta o Sales EMITIR o campo (`apps/sales-command/.../sales/service.ts` `crmPayload` e `crm-http-adapter.ts`, `couple.publicCode`). Isso é mudança do lado da Suite: fluxo Suite -> CRM -> re-pin; este PR não força nada.

## Flags (todas DESLIGADAS, declaradas em `.env.example` e `infra/pilot/docker-compose.yml`)

- `CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY` (F1.6).
- `SALE_BRIDGE_REUSE_CAPTURE_ENABLED` (F1.10, reaproveitamento por visita recente; o por `coupleCode` não depende de flag porque a chave é única).
- O alerta de F1.4 não tem flag própria: a observação do 422 só roda com `ENCOUNTER_TIMES_RECEIVER_ENABLED=true`; o painel só lê.

## Limites honestos

- O vínculo do check-in continua sendo um ato humano (ligar o código à ficha); o que mudou é que a falta dele aparece e a ligação é de um clique. Ligar sozinho por palpite (um código sem ficha + uma ficha sem código) foi descartado: ligar o casal errado manda tempos para a ficha errada.
- A observação do 422 não vê casal que o Sales nunca tentou entregar; para esse caso vale o lado "ficha que chegou sem código".
