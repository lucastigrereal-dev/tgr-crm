# TGR CRM — KAN-31 Receipt rodada 2 — 04/10/2026

Branch `kan-31/homolog-r2` · base `515405e` (= `origin/kan-31/homolog`)
Executor: Claude Code coordenador (Opus 5.5 + advisor), escrita direta autorizada por Lucas. Sem PR, merge, deploy, produção, dado real, segredo real ou GuestPass.
Ambiente: Windows 11, Node 24.13.0, pnpm 10.26.2, MySQL 8.4 descartável (loopback, tmpfs, senhas aleatórias nunca impressas, removido no fim).

## Commits

| SHA | Item |
| --- | --- |
| `e8b1a1d` | Asaas fail-closed: sem `ASAAS_API_URL` explícita (https) a integração fica desligada; `config-doctor` avisa |
| `6c43679` | Drift de schema: `schema.ts` + snapshot 0042 alinhados às FKs reais (metadado, sem SQL) + teste de drift MySQL |
| `44c6062` | Seed sintético do laboratório (valores fictícios: 12 UHs × 10 cotas = 120 frações), idempotente, só em banco isolado |
| `7425209` | Matriz RBAC papel × ação crítica nos routers reais, com gabarito fixo |

## Resultado por achado aberto do receipt r1

| Achado | Resultado | Evidência |
| --- | --- | --- |
| Drift `schema.ts` × schema real | **FECHADO** | Banco migrado do zero vs snapshot: colunas 586=586, índices 161=161, FKs 106 com 6 divergências: `contract_documents.contractId` ausente no schema; 5 FKs de nome curto real (`reneg_*`, `pg_webhook_billing_fk`, `revenue_ledger_policy_fk`) declaradas com nome padrão de mais de 64 caracteres; FK duplicada em `contract_monetary_adjustments.contractId`. O `generate` antes da correção propunha 6 DROP + 6 ADD de FKs. Depois: "No schema changes". `server/schemaDrift.mysql.test.ts` RED→GREEN. Nenhuma migration SQL criada, porque o banco real já está correto. |
| Asaas cai em produção com URL vazia | **FECHADO (código)** | `server/paymentGateway.test.ts`: 2 testes RED→GREEN. `configDoctorLocalAuth.test.ts`: +1 RED→GREEN. **Gate de deploy:** o env de produção precisa ter `ASAAS_API_URL` explícita, senão o Asaas fica desligado. |
| `sellerId=null` / papéis no evento v1 | ABERTO (produto) | Precisa de decisão de contrato de evento v2. Não tocado. |
| `vitest` < 4.1.11 (dev) | ABERTO (baixo) | Upgrade de major separado. |

## Itens novos

| Item | Resultado | Evidência |
| --- | --- | --- |
| Seed sintético 12×10 | PASS | `server/syntheticPilotSeed.mysql.test.ts` 3/3: 1 resort, 12 UHs, 120 frações `available`; reexecução sem duplicar; preço `19750.00` e tabela `SYN-NAO-APROVADO` (fixture **NÃO APROVADO**). A CLI `scripts/seed-synthetic-pilot.ts` recusa banco que não seja `_e2e/_test/_staging`. |
| RBAC papel × ação | PASS | `server/rbacMatrix.test.ts` 12/12. 11 mutações protegidas mais a decisão de desconto, testadas em 5 papéis. Teste de mutação: ampliar a matriz quebra 3 testes; remover o guard do router quebra 1. |
| Divergência RBAC encontrada | **RESOLVIDA (ADR-002, 2026-10-04)** | Finance/service/seller pedem distrato; só admin decide e executa (commit `20d4601`). |
| Idempotência | Coberta (r1) | Replay de webhook Clicksign/Asaas e de `saleId` do Sales Command já cobertos nas suítes MySQL (concurrencyGuards, eSignature, salesCommandBridge). |

## Gates no HEAD de código `7425209` (log: `C:\TGR\_receipts\KAN-31_r2_gates_7425209.log`)

- `pnpm check`: exit 0.
- `pnpm test`: 142 arquivos / **478 testes PASS**; 5 arquivos / 17 opt-in pulados sem MySQL. Antes: 463.
- MySQL opt-in, banco migrado do zero (43/43, 49 tabelas): **17/17 PASS**. Drift 1, seed 3, Clicksign 4, guards 3, Sales Command 6.
- `pnpm build`: exit 0. Budget: app 149.8/450 KB, Excel 264.4/300 KB, PDF 123.4/150 KB.

## Não executado

- E2E Playwright e drill de backup em bash/Linux: não reexecutados nesta rodada. O r1 registrou E2E 7/7 e drill PASS, e o código de UI e de backup não mudou.
- Push: **retido** até um "sim" do Lucas no chat, porque o tgr-crm é público e o push publica o código.

## Pendências humanas

1. GO para push de `kan-31/homolog-r2` (repo público, R-01).
2. Produção: definir `ASAAS_API_URL` explicitamente antes de qualquer deploy desta branch.
3. ~~Produto: finance/service podem pedir distrato?~~ Decidido (ADR-002): sim, pedem; só admin decide/executa.
4. Produto: papéis comerciais (liner/closer) no evento Sales→CRM v2, para comissão automática.
5. Merge em `main`: gate humano.

## Veredito

KAN-31 r2: **IN REVIEW**. Os 2 achados técnicos abertos foram fechados com prova; seed e RBAC foram adicionados; nada regrediu. Restam decisões de produto e o GO de push/merge.
