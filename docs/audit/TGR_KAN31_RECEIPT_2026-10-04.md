# TGR CRM — KAN-31 Homologation Receipt — 04/10/2026

## Escopo

Execução da missão `docs/TGR_CLOUD_MISSION_KAN31.md` no branch `kan-31/homolog`, em container cloud efêmero.
Sem PR, merge, deploy, produção, dado real, segredo real ou integração GuestPass.

- Base: `f039994` (= `main` `bcca1c2` + doc da missão)
- Head de código certificado: `5df449c` (este recibo vem no commit seguinte)
- Banco: MySQL 8.4.11 em container descartável (`mysql:8.4`), usuário de aplicação sem root, bancos `*_e2e`
- Runtime: Node 22.22.0, pnpm 10.26.2

## Commits

| SHA | Item |
| --- | --- |
| `bd517f7` | Clicksign reconciliado sobre a `main` atual (port de `feat/tse-cutover-esign-v1`, migration 0040 → 0042) |
| `997c35c` | Testes em MySQL real: fração exata e atribuição Sales Command |
| `6c0348c` | Fix: erro de chave duplicada embrulhado pelo drizzle (9 pontos) |
| `6e8296f` | Fix: 26 guards `affectedRows` mortos em produção |
| `715b397` | Fix: `contract.document.signed` único por documento + Clicksign local em MySQL real |
| `6613642` | Dependências: vulnerabilidades de produção 23 → 0 |
| `b7b6191` | Drill Linux de backup + restore com checksum por tabela |
| `e603365` | Segurança: envio de e-sign só admin; token Asaas em tempo constante |
| `5df449c` | Fix: cobrança Asaas parcial não soma duas vezes |

## Resultado por item da missão

| Item | Resultado | Evidência |
| --- | --- | --- |
| Recertificar baseline | PASS | Base `f039994`: tsc 0, Vitest 137/449 PASS, build PASS, budget PASS |
| Corrigir problemas com evidência | PASS | 5 bugs reais corrigidos, cada um com teste que falha no código antigo (abaixo) |
| Fração exata e atribuição | PASS | `server/salesCommandBridge.mysql.test.ts` 6/6 em MySQL real |
| Reconciliar Clicksign localmente | PASS | Port sem conflito de código; `server/eSignatureService.mysql.test.ts` 4/4 com HMAC local, sem rede |
| Backup/restore | PASS | `infra/pilot/backup-restore-drill.sh`: 49 tabelas, contagem + `CHECKSUM TABLE` iguais; teste negativo detecta 0,01 |
| Revisão de segurança | PASS com pendências | 2 correções; achados abertos listados abaixo |
| Recibos | PASS | Este documento |

## Gates finais no head `5df449c`

- `pnpm check`: exit 0
- `pnpm test`: 141 arquivos / 463 testes PASS; 3 arquivos / 13 testes opt-in pulados sem MySQL
- Suítes MySQL opt-in (`TGR_MYSQL_INTEGRATION_URL`): 13/13 PASS
- E2E autenticado estrito (mesmo fluxo do job `e2e` do CI, local, Chromium headless): **7/7 PASS** em 31,2 s. Run `kan31_local`, banco `tgr_crm_kan31_local_e2e`, porta 43337. Fluxos: captação mobile, CSV com undo, XLSX/PDF, reserva, sala, Sales Command e distrato. Cleanup `CLEANUP_EXIT=0`; porta livre depois do run.
  - Para isso foi usado o Chromium 1194 já instalado na máquina, via config temporária não versionada e symlink temporário do headless shell; ambos foram removidos. O CI do repo só roda em PR/main, então não houve run remoto.
- Migrations do zero (`drizzle-kit migrate`): exit 0, 43/43 aplicadas, 49 tabelas
- `pnpm build`: exit 0
- Budget gzip: app 149.8/450 KB, Excel 264.4/300 KB, PDF 123.4/150 KB
- `pnpm audit --prod`: 0 vulnerabilidades (antes: 23, sendo 12 high)
- `pnpm audit` completo: 2 moderate restantes (antes: 28), ambas no `vitest` < 4.1.11, só em dev

Comando das suítes MySQL:

```bash
TGR_MYSQL_INTEGRATION_URL=mysql://<app>:<senha>@127.0.0.1:<porta>/<banco>_e2e npx vitest run server/*.mysql.test.ts
```

O nome do banco precisa terminar em `_e2e`, `_test` ou `_staging` (`validateIsolatedE2EDatabase`), e ele não pode ser o `DATABASE_URL` operacional.

## Bugs reais encontrados e corrigidos

### 1. Guards de concorrência por `affectedRows` nunca disparavam (`6e8296f`)
- **Causa raiz:** com drizzle + mysql2, `update`/`delete` retorna `[ResultSetHeader, fields]`. Os 26 guards testavam `"affectedRows" in result` no array. Os mocks dos testes devolviam `{ affectedRows }` no formato objeto, por isso a suíte ficava verde.
- **Prova:** probe em MySQL 8.4 retornou `isArray true hasAffected false`.
- **Impacto real em produção:** `PAYMENT_CONFIRMED` seguido de `PAYMENT_RECEIVED` para o mesmo pagamento Asaas lançava a **receita duas vezes**. `markDocumentSigned` repetido também não era detectado.
- **Regressão:** `server/concurrencyGuards.mysql.test.ts` falha no código antigo (2/2) e passa no novo.
- **Verificação:** mysql2 conta linhas casadas (FOUND_ROWS). Um update sem mudança retorna `affectedRows=1`, então writes sem efeito não viram CONFLICT.

### 2. Chave duplicada embrulhada pelo drizzle (`6c0348c`)
- **Causa:** `DrizzleQueryError` guarda o `ER_DUP_ENTRY` em `cause`. Por isso, corridas de idempotência (webhooks Clicksign/Asaas, Sales Command, chaves de idempotência financeiras) viravam 500/503 em vez de replay ou CONFLICT.
- **Prova:** entrega simultânea duplicada do webhook Clicksign falhou com `Failed query … Caused by: Duplicate entry` e passou após o fix.

### 3. Evento `contract.document.signed` duplicado (`715b397`)
- `envelope_closed` também conta como evento de fechamento, então o evento de documento assinado era reemitido. Agora só é emitido na transição `signed` false → true.

### 4. Envio de assinatura eletrônica sem controle de papel (`e603365`)
- Qualquer perfil interno podia criar envelope Clicksign, o que envia e-mail ao cliente e gera custo. Agora exige `document.sign` (admin), igual à confirmação manual.
- **Regressão:** `server/electronicSignatures.access.test.ts` falha em 3/4 no router antigo.

### 5. Cobrança Asaas parcial somada duas vezes (`5df449c`)
- Parcela de 300,00 com cobrança de 100,00, recebendo `PAYMENT_CONFIRMED` e depois `PAYMENT_RECEIVED`.
- **Antes:** receitas `["100.00","100.00"]`. **Depois:** `["100.00"]`, `paidAmount` 100,00 e parcela `open`.
- **Correção:** o webhook encerra quando a cobrança travada já está `paid`; o evento continua registrado para manter a idempotência.

## Fração exata e atribuição — o que está provado

`materializeSalesCommandSale` em MySQL real:
- Vende exatamente `quotasCount` frações, ligadas a contrato e proposta, com histórico 1:1. O resto do estoque fica intocado.
- VGV de 1.000.001 centavos com 3 parcelas de entrada, 7 de saldo e entrada parcial: soma das parcelas, entrada, valor pago e receita fecham **ao centavo**. O saldo varia no máximo 1 centavo entre parcelas.
- Atribuição: contrato, oportunidade, cliente e captação carregam a origem Sales Command, `saleId`, `encounterId` e `correlationId` na linhagem. `sellerId` fica `null` e **nenhuma comissão é inventada**.
- Replay do mesmo `saleId` não altera nada.
- Corrida do mesmo `saleId` gera erro de chave duplicada reconhecível.
- Estoque insuficiente faz rollback total.
- Duas vendas concorrentes nunca vendem a mesma fração.
- Teste de mutação: remover os locks quebra o teste de corrida; mexer no arredondamento quebra o de centavos.

## Clicksign — reconciliação

- O branch `feat/tse-cutover-esign-v1` estava 19 commits à frente e 74 atrás da `main`, com a migration `0040` em conflito com `0040_sales_command_formalization`.
- No port, o código aplicou em 3-way sem conflito. O SQL ficou idêntico ao original, renumerado para `0042`.
- O `drizzle-kit generate` propôs statements de drift: `DROP FOREIGN KEY contract_documents_contractId_contracts_id_fk`, re-add de FK de reajuste e a coluna da 0041. Eles **não** foram aplicados, porque esses objetos já existem no schema real.
- Nenhuma chamada ao provedor foi feita. Sem `CLICKSIGN_API_TOKEN` e `CLICKSIGN_WEBHOOK_SECRET`, o webhook responde 503 e o envio fica indisponível.

## Backup e restore

O drill roda `infra/pilot/backup-restore-drill.sh` contra o banco sintético `tgr_crm_kan31_e2e`, com volume de documentos sintético:

- **Resultado:** `BACKUP_RESTORE=PASS`, `VERIFIED_TABLES=49`, 24 tabelas não vazias, 1.654 linhas.
- **SHA-256 do dump:** `0c1ce89ca01d5b14…`. **SHA-256 do arquivo de documentos:** `f3b590500de5b8b1…`.
- **Teste negativo:** alterar 0,01 em uma parcela restaurada muda o `CHECKSUM TABLE` (2000670454 → 4057825257).
- O dump é feito pelo usuário de aplicação, sem root. As credenciais do verificador são aleatórias e nunca impressas. O container descartável é removido no `trap`.

## Achados abertos (não corrigidos de propósito)

| Achado | Risco | Encaminhamento |
| --- | --- | --- |
| Drift entre `drizzle/schema.ts` e o schema real: FK de `contract_documents.contractId` ausente no schema.ts, nome de FK de `contract_monetary_adjustments` divergente, sem snapshot da 0041 | Um `drizzle-kit generate` futuro proporia **DROP de FK real** | Mudança dedicada alinhando o schema.ts e revisando o SQL gerado à mão |
| `getAsaasConfig` usa `https://api.asaas.com` (produção) quando `ASAAS_API_URL` está vazio | Chave de sandbox ou dev pode bater em produção | Exigir URL explícita, como o Clicksign já faz; mexe em configuração de produção, depende de GO |
| Contrato vindo do Sales Command entra com `sellerId = null`; o evento v1 não traz liner/closer | Comissão automática dessas vendas não nasce | Decisão de produto: incluir papéis no contrato de evento v2 |
| `vitest` < 4.1.11 (2 moderate, dev) | Só em dev | Upgrade de major separado |

## Não executado

- Diário no Notion: este ambiente cloud não tem conector Notion, então nada foi escrito lá.

## Fronteiras respeitadas

- Commits e push somente em `kan-31/homolog`.
- Nenhum PR, merge, deploy, acesso a produção, dado real ou segredo real.
- Nenhuma chamada de rede a Clicksign ou Asaas: as chaves são fictícias e geradas só para os testes.
- GuestPass: nenhum arquivo tocado (`git diff f039994..HEAD` não tem nenhuma ocorrência).

## Veredito

KAN-31 homologação técnica: **PASS** dentro do escopo controlável, com 5 correções de bug reais e provadas e E2E autenticado verde. Merge na `main` e o encaminhamento dos achados abertos dependem de GO humano.
