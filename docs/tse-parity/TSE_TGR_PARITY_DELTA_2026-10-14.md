# Delta da matriz TSE → TGR · 14/10/2026

A matriz `TSE_TGR_PARITY_MATRIX_V1.md` (58 capacidades) é um retrato da base `c9c2e10` de 26/09/2026, trazida da PR #6 sem alterar o conteúdo.
Este arquivo registra o que mudou na `main` do CRM desde então (`653acc4`). Onde as duas discordam, vale este delta; linha não citada aqui não foi reconferida.

| Capacidade (matriz V1) | Status V1 (26/09) | Status na main 653acc4 | Evidência na main |
|---|---|---|---|
| Reajuste monetário/indexadores | AUSENTE | PARCIAL (backend + tela; política real de índice não homologada) | `contract_monetary_adjustments`, `monetary_index_values`, `server/routers/monetaryAdjustments.ts` (simulate/applyAdjustment), `client/src/pages/MonetaryAdjustments.tsx`, `docs/tse-parity/MONETARY_ADJUSTMENT_V1.md` |
| Assinatura eletrônica | PARCIAL | PARCIAL (adapter Clicksign, envelope, webhook idempotente e reconciliação prontos; falta credencial real) | `server/clicksign.ts`, `server/eSignatureService.ts`, `drizzle/0042_tse_cutover_esign.sql`, `eSignatureService.mysql.test.ts` |
| Cota/fração vendável | AUSENTE | PARCIAL (backend provado em MySQL; tela não reconferida aqui) | `commercial_fractions`, `commercial_fraction_history`, `inventoryBootstrap.mysql.test.ts` (60 UH × 52 cotas), `client/src/pages/CommercialInventory.tsx` |
| Reserva temporária de cota durante proposta | AUSENTE | PARCIAL (hold com proposta, dono, `expiresAt`, liberação; concorrência provada em MySQL) | `commercial_fraction_holds`, `concurrencyGuards.mysql.test.ts` |
| Mapa de estoque e disponibilidade de venda | AUSENTE | PARCIAL (tela existe; não reconferida contra as 3.120 cotas do produto Natal) | `client/src/pages/CommercialInventory.tsx`, `server/routers/inventory.ts` |
| Ledger e DRE gerencial | PARCIAL ("Financial Layer em PR aberto") | PARCIAL (Financial Layer está na main da Suite; homologação pendente) | `tgr-commercial-suite` `apps/financial-layer`; ponte `server/financialBridge.ts` |
| PIX/Boleto com baixa automática | PARCIAL | PARCIAL (baixa e eventos na mesma transação desde a #45; credencial Asaas real pendente) | `server/paymentGatewayWebhook.ts`, `installmentSettlementOutbox.mysql.test.ts` |
| Empresa / unidade de negócio permitida | PARCIAL | PARCIAL (sem conceito de empresa; decisão de produto pendente) | `drizzle/schema.ts` sem tabela de empresa |
| Paridade dos 103 campos do Controle de Sala | PARCIAL | PARCIAL (lista-fonte dos 103 campos segue ausente em repo, Notion e Biblioteca) | depende do arquivo original `PROVA_TSE_2025_CONTROLE_SALA` ou da Aurora |

As contagens da seção "Resumo" da matriz V1 (35/1/14/8, 11 P0) são de 26/09 e não foram recalculadas.
