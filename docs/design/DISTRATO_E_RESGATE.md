# Desenho: resgate pelo pós-vendas e distrato automático configurável

Estado: **SÓ DESENHO**. A migration proposta foi aplicada e desfeita (rollback) apenas num MySQL local descartável, para provar que a sintaxe e o rollback funcionam. Nenhum código de produção, nenhuma migration aplicada. A migration está PROPOSTA em `migrations/proposed/PROPOSED_0086_rescue_and_auto_cancellation.sql` (pasta que nunca roda). Tudo abaixo nasce atrás de flag OFF e de configuração desligada.

## 1. Decisões do Lucas (entrada)

1. Reserva vencida segue as regras do contrato. **O modelo ainda vai chegar**; este desenho só deixa o ponto de encaixe (seção 6).
2. Distrato automático pode existir, **configurável**: prazo e liga/desliga na tela do admin, **padrão DESLIGADO**, com histórico de quem mudou.
3. Fila e alerta de resgate para o pós-vendas; prazo padrão de 3 meses, configurável.
4. Cobrança judicial e negativação **nunca são automáticas**: só alerta para decisão humana.
5. O pós-vendas tenta resgatar **antes** do distrato.

Suposições a confirmar (marcadas **[CONFIRMAR]**): (a) "pós-vendas" = papel `service` (Atendimento) mais `admin`, via capacidade `rescue.work`; (b) o prazo de 3 meses conta a partir da primeira parcela vencida e não paga do contrato. Ambas respondidas pelo Opus na seção 10, com confirmação final do Lucas.

## 2. O que já existe e não muda

- Distrato manual em três passos, em `server/routers/contracts.ts`: `requestCancellation` (cria `contract_cancellation_requests` em `requested`, snapshot da simulação), `decideCancellation` (aprova/rejeita, humano) e `executeCancellation`. A execução, numa só transação, cancela parcelas e cobranças abertas, cancela comissões (política `onPaidCommissionCancellation`), cria lançamentos financeiros de multa/reembolso, devolve a cota ao estoque, emite `contract.status.updated`, `contract.cancellation.executed`, `commission.*`, `financial.entry.created`, `commercial.fraction.status.changed` e chama `eligibilityHook`.
- Reserva vencida (CRM-INV, #113): `markContractInventoryLost` grava `inventoryLostAt`, abre a tarefa ao administrativo e emite o evento interno `contract.inventory_lost`.
- Política de cancelamento por empreendimento (`commercialProjectSettings.cancellationPolicy`) e `simulateCancellation`.

Princípio: o distrato automático **reutiliza a mesma execução**. Nenhuma regra de dinheiro nova; só muda quem aciona e quando.

## 3. Estados

### 3.1 Caso de resgate (`contract_rescue_cases`)

```
            (parcela vence sem pagar)
                     |
                     v
                  [open] --tentativa registrada--> [in_contact]
                     |  \                              |
                     |   \--paga/renegocia------------>+--> [rescued]   (fim)
                     |                                 |
        prazo vence (rescueDueAt) sem resgate          +--> [dismissed] (pós-vendas encerra, com motivo)
                     |
                     v
              [due_for_cancellation]  --(distrato AUTOMÁTICO ligado)--> pedido de distrato (seção 3.2)
                     |                --(desligado)------------------> só alerta ao admin: decidir à mão
                     |  \--(erro de domínio, ou fora de um teto da seção 10)--> [manual_review]
                     v                                                         |  (admin decide à mão:
            [cancelled]  (contrato distratado, por qualquer via; fim)           |   distrato manual -> cancelled;
                                                                                |   "tentar de novo" -> due_for_cancellation;
                                                                                |   encerrar -> dismissed)
```

- Um único caso ABERTO por contrato (`activeKey = rescue:<contractId>` único; nulo ao fechar). `open`, `in_contact`, `due_for_cancellation` e `manual_review` são estados abertos e mantêm o `activeKey`.
- `manual_review` é estado PERSISTIDO de saída do automático: guarda `manualReviewReason` (`domain_error`, `over_cap`, `paid_commission`, `open_renegotiation`, `recent_promise`) e `manualReviewAt`. O job de distrato automático só seleciona `status = 'due_for_cancellation'`; um caso em `manual_review` nunca é reexecutado até um humano agir ("tentar de novo" devolve a `due_for_cancellation`, com auditoria).
- `rescued` é automático quando as parcelas vencidas do contrato ficam todas pagas/renegociadas (verificado no job e no pagamento); `dismissed` e `cancelled` fecham o caso.
- **Supressão após `dismissed`** (impede o sweep de recriar o caso e reiniciar a janela de resgate com a mesma parcela vencida): ao encerrar, grava-se `suppressUntil = closedAt + rescueReopenAfterDays` (configuração, padrão 90 dias). O sweep só abre caso novo para o contrato se **não houver caso aberto** E **não houver caso `dismissed` do contrato com `suppressUntil` no futuro**, a menos que exista parcela **nova**: não paga, vencida, com `dueDate` posterior ao `closedAt` desse caso (fato novo). Passado o `suppressUntil`, reabre normalmente, com `rescueDueAt` novo e `contract.rescue.opened` de chave nova (a `firstOverdueDate` entra na chave).
- Cada tentativa vai para `contract_rescue_attempts` (canal, resultado, nota, autor, hora). Tentativa move `open -> in_contact` e atualiza `lastAttemptAt`.

### 3.2 Distrato automático

Não há estado novo no distrato. Quando o caso chega a `due_for_cancellation` e a configuração vigente tem `autoCancelEnabled = true`:

1. cria um `contract_cancellation_requests` com `origin = 'auto'` (coluna aditiva, padrão `'manual'`), com o snapshot da simulação da política do empreendimento;
2. aprova e executa pelo MESMO caminho de `executeCancellation` (função extraída, sem duplicar regra), com ator de sistema. **[CONFIRMAR]** `requestedByUserId`/`decidedByUserId` são NOT NULL hoje: usar um usuário de sistema dedicado e configurado, ou tornar as colunas anuláveis. Recomendação: usuário de sistema, sem mexer em coluna existente.

Recomendação de segurança (sugestão minha, não decisão do Lucas): primeiro modo **ensaio** (`AUTO_CANCELLATION_DRY_RUN=true`, padrão): grava o que faria (evento `contract.auto_cancellation.would_run` e auditoria) sem executar. Só depois de uma semana de ensaio conferido por humano se desliga o ensaio.

### 3.3 Alertas jurídicos (`legal_action_alerts`)

Tipos: `judicial_collection` (cobrança judicial) e `credit_bureau_listing` (negativação). Estados: `open -> decided_proceed | decided_dismissed`. **Não existe código que execute qualquer das duas ações**; o alerta só pede decisão humana (admin) e guarda quem decidiu, quando e a nota. Um alerta aberto por contrato e tipo (`activeKey`). Nada aqui chama sistema externo.

## 4. Configurações (tela do admin, com histórico)

Tabela versionada append-only `retention_settings_versions` (a vigente é a de maior `id`, como o catálogo de indicadores e o mapa de papéis):

| Campo | Padrão | Significado |
|---|---|---|
| `rescueWindowMonths` | 3 | Prazo do resgate, contado da primeira parcela vencida não paga **[CONFIRMAR]**. 1 a 24. |
| `rescueAlertLeadDays` | 15 | Quantos dias antes do fim do prazo o pós-vendas recebe o alerta de "vai vencer". |
| `rescueReopenAfterDays` | 90 | Quanto tempo um caso `dismissed` suprime a reabertura pelo sweep (salvo parcela nova vencida). 1 a 730. |
| `autoCancelEnabled` | **false** | Liga/desliga o distrato automático. |
| `autoCancelPromiseDays` | 15 | Teto: sem distrato automático se houve tentativa `promised_payment`/`renegotiating` nos últimos N dias (ou renegociação aberta). |
| `autoCancelMaxPaidPercent` | 30 | Teto: sem distrato automático se o valor já pago passa de X% do contrato. |
| `createdByUserId`, `createdAt`, `note` | | Quem mudou, quando, por quê. |

Sem linha na tabela (ou flag mestra OFF): valem os padrões acima e o distrato automático fica desligado. A tela segue o padrão das abas de "Configurações da empresa" (uma aba nova, só admin, histórico visível). Trocar o prazo vale para casos **abertos depois**; casos abertos guardam `settingsVersionId` e o `rescueDueAt` calculado (mudança de configuração não move prazo de caso em andamento sem ação explícita do admin).

## 5. Eventos (todos INTERNOS, `domain_events`, sem entrega externa nesta fatia)

| Evento | Quando | idempotencyKey |
|---|---|---|
| `contract.rescue.opened` | caso aberto | `rescue-open:<caseId>` |
| `contract.rescue.attempted` | tentativa registrada | `rescue-attempt:<attemptId>` |
| `contract.rescue.due_soon` | entrou na janela de alerta | `rescue-due-soon:<caseId>` |
| `contract.rescue.resolved` | `rescued`, `dismissed` ou `cancelled` | `rescue-resolved:<caseId>` |
| `contract.auto_cancellation.would_run` | ensaio | `auto-cancel-dry:<caseId>` |
| `contract.auto_cancellation.requested` | pedido automático criado | `auto-cancel:<caseId>` |
| `legal_action.alert_opened` / `legal_action.decided` | alerta jurídico | `legal-alert:<contractId>:<kind>` / `legal-decided:<alertId>` |

Payload só com ids, datas e códigos (sem nome, telefone, valores livres). O distrato automático, ao executar, emite os eventos que o distrato manual já emite (a Suite já os conhece). Entregar qualquer evento novo ao Sales/Financial/Recovery **exige contrato novo e GO**; não faz parte desta fatia.

## 6. Reserva vencida (ponto de encaixe)

Hoje: `inventoryLostAt` + tarefa + `contract.inventory_lost`. O modelo do Lucas vai definir o que acontece com o contrato (prazo, devolução do que foi pago, distrato). Encaixe previsto: `contract_rescue_cases.reason = 'reservation_expired'` (além de `overdue`), aberto pelo mesmo gancho que hoje chama `markContractInventoryLost`, com o prazo e a regra vindos do modelo. **Até o modelo chegar, nada muda no comportamento atual.** Isso também resolve a condição escrita no `.env.example` para ligar `INVENTORY_HOLD_AT_FORMALIZATION` (entrega ou distrato automático).

## 7. Atrás de flag OFF

| Flag (env, nasce `false`) | Efeito ligada |
|---|---|
| `RESCUE_QUEUE_ENABLED` | Job que abre/fecha casos, rotas da fila e do registro de tentativas, aba/tela de configuração. |
| `AUTO_CANCELLATION_ENABLED` | Permite o caminho automático. Mesmo ligada, só age se a configuração vigente tiver `autoCancelEnabled = true`. |
| `AUTO_CANCELLATION_DRY_RUN` (nasce `true`) | Ensaio: registra e não executa. |

Cobrança judicial e negativação **não têm flag porque não têm execução**: só o alerta. Nova capacidade `rescue.work` (pós-vendas e admin) e `rescue.configure` (só admin), seguindo `shared/permissions.ts`; as chaves de flag entram na deny-list da tela de flags (não se liga distrato automático pela tela de recursos).

## 8. Idempotência e concorrência

- Job de varredura periódico (intervalo configurável, uma instância por vez via lock de aplicação): seleciona contratos com parcela vencida, sem caso aberto e sem supressão vigente (seção 3.1: `dismissed` com `suppressUntil` no futuro e nenhuma parcela nova vencida). Reexecutar não duplica: `activeKey` único + `idempotencyKey` dos eventos.
- Ordem de locks (a mesma do restante do CRM): **contrato -> parcelas -> caso de resgate -> pedido de distrato**. O job abre uma transação por contrato com `withDeadlockRetry`.
- Distrato automático: antes de criar o pedido, relê o caso e o contrato `FOR UPDATE`; se o contrato já estiver `cancelled`, ou já existir pedido em `requested|approved` (regra atual do `requestCancellation`), não faz nada. Chave `auto-cancel:<caseId>` impede segundo pedido.
- Pagamento que chega durante a execução: o `FOR UPDATE` das parcelas decide; se a parcela foi paga antes do lock, o caso vira `rescued` e nada é cancelado.
- Falha transitória (deadlock/lock timeout) sobe e é repetida; erro de domínio é registrado e o caso passa a `manual_review` (`manualReviewReason = domain_error`), estado que o job exclui do predicado de seleção; só a ação humana o reabre. É isso que torna "nunca reexecutado em laço" implementável.

## 9. Migration proposta (`PROPOSED_0086`)

Aditiva, sem backfill, sem tocar linha existente. Escrita no formato das migrations Drizzle, com `--> statement-breakpoint` entre as instruções (necessário quando virar migration real): 4 `CREATE TABLE IF NOT EXISTS` (`retention_settings_versions`, `contract_rescue_cases`, `contract_rescue_attempts`, `legal_action_alerts`) e 1 `ALTER TABLE contract_cancellation_requests ADD COLUMN origin ... DEFAULT 'manual'`. Rollback no cabeçalho do arquivo. Como nas demais propostas, `drizzle/schema.ts` só ganha as tabelas depois da migration aplicada (o teste de drift compara schema x banco).

## 10. Decisões (respostas do Opus) e o que continua com o Lucas

Respondidas (valem para o PR de código; o Lucas confirma o que está marcado):
1. **Ator do distrato automático**: usuário de sistema DEDICADO, sem login e sem senha, criado por seed no PR de código, que aparece na auditoria como "sistema". Nenhuma coluna NOT NULL existente muda (`requestedByUserId` e `decidedByUserId` continuam obrigatórias e recebem o id desse usuário).
2. **Tetos de segurança, OBRIGATÓRIOS antes de qualquer distrato automático real**, todos configuráveis na mesma tela do admin (colunas na tabela versionada `retention_settings_versions`, com histórico). Fora de qualquer teto, o caso NÃO é distratado sozinho: vai para o estado `manual_review` (decisão manual do admin).
   - Nunca automático com comissão já paga (cai na revisão manual da ADR-010, como hoje).
   - Nunca com renegociação aberta, nem com tentativa de resgate `promised_payment` ou `renegotiating` nos últimos N dias (padrão 15, configurável).
   - Nunca quando o valor já pago passar de X% do contrato (padrão 30%, configurável).
3. **Ensaio**: `AUTO_CANCELLATION_DRY_RUN` nasce `true`; sair do ensaio é decisão do Lucas.
4. **Pós-vendas**: papel `service` + `admin`, por meio da capacidade `rescue.work` atribuível (tela de permissões). O prazo de 3 meses conta da PRIMEIRA parcela vencida e não paga; confirmação final do Lucas.

Continuam com o Lucas: o **modelo da reserva vencida** (seção 6) e **quem recebe o alerta jurídico** (e o texto dele).

Impacto na migration proposta: `retention_settings_versions` ganha as colunas dos tetos (`autoCancelPromiseDays` padrão 15, `autoCancelMaxPaidPercent` padrão 30) e `rescueReopenAfterDays` (padrão 90); `contract_rescue_cases` ganha o status `manual_review`, `manualReviewReason`, `manualReviewAt` e `suppressUntil`; o arquivo `PROPOSED_0086` já foi atualizado. O rollback da proposta só vale em banco de teste ou sintético, nunca com dado real.
