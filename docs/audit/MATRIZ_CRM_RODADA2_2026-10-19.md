# CRM, rodada 2: matriz e provas (2026-10-19)

Base: `main` fd84f05 (PR #78 integrado). Ramo `claude/crm-rodada2`. O GitHub Actions da conta está bloqueado por cobrança, então **não há CI**: toda a prova abaixo é local, em MySQL 8.0 descartável (banco por execução, sufixo `_test`/`_e2e`, nunca banco real), com gateway Asaas simulado em memória (nenhuma credencial real, nenhuma chamada de rede). SHAs de commit ficam no corpo do PR e na resposta ao coordenador (este arquivo não pode citar o SHA do próprio commit).

Regras mantidas: nada em banco real; migrações só em MySQL descartável; nenhum teste desligado; só dado sintético; comissão positiva TRAVADA; endpoint do NQ desligado por padrão; o CRM não vira dono de dado de outro sistema; regra de empresa vira configuração com padrão.

## Itens

| Item | Estado | Prova local | O que NÃO está provado / decisão aberta |
| --- | --- | --- | --- |
| CRM-A13 motor V2 na geração por parcela | LIGADO e TRAVADO (`COMMISSION_V2_RELEASED=false`) | `commissionV2Wiring` 9 unit; `commissionV2.mysql` 5 (travado por padrão e com "1"; liberado: baixa manual e webhook Asaas geram na mesma transação do evento, falha injetada em `commission.created` desfaz tudo, repetição não duplica; entrada em duas parcelas soma 800/100/100) | **Liberar é do Lucas.** Confirmar o mapeamento captador->`promoter`, consultor->`liner`, fechador->`closer`, cotas = frações vendidas, entrada = entrada da proposta |
| CRM-A10 cobrança Asaas órfã | RECUPERAÇÃO DURÁVEL (migração 0068) | `gatewayRecovery.mysql` 4 (órfã criada no gateway + falha local: intenção sobrevive, recuperação reconstrói cobrança, auditoria e evento uma vez; idade mínima respeitada; gateway recusou: abandonada; parcela encerrada: revisão manual); `finance.gateway-integrity` 5; rollback 0068 em `migrationRollback.mysql` | Asaas real (só simulado); cancelar a cobrança remota de parcela encerrada é ação humana no gateway. Job ligado por padrão (`GATEWAY_RECOVERY_ENABLED`), só lê o gateway e só age com intenção pendente |
| CRM-A11 renegociação (lado CRM) | FLUXO COMPLETO no CRM: propor, aprovar, aplicar, encerrar | `renegotiation.mysql` 5 (quem propôs não aprova por padrão, configurável; aplicar cria a parcela nova, renegocia a original, cancela cobrança local aberta, evento e `installment.scheduled` juntos; falha injetada desfaz tudo; saldo mudou, parcela paga e acordo cancelado são recusados) | **Lado do Financial:** cancelar a parcela pendente dele é dele. O CRM só emite `installment.renegotiation.applied` (evento interno, fora da ponte) com os ids de cobrança/gateway a cancelar e `installment.scheduled` da parcela nova. Falta o Financial aceitar um sinal de cancelamento. Quem aprova e se há alçada de desconto é decisão de produto (hoje: perfil financeiro, quem propôs não aprova) |
| INT-13 só escreve no que é seu (CRM) | PROVADO | `ownerWrites` 8 (lista explícita por módulo de integração, tudo no schema do CRM, SQL cru só em tabela do CRM); `ownerWrites.mysql` 1 (diferença de linhas em TODAS as tabelas: evento aceito altera só `encounter_time_records` e `audit_logs`; recusado não altera nada) | GuestPass fica fora (não é deste repositório) |
| CRM-A03 E2E de navegador do estoque | PROVADO local | `e2e/strict-isolated.spec.ts` 14/14 no Chromium, incluindo o novo: materializar cotas, idempotência, hold, bloqueio com motivo, desbloqueio, busca, sem overflow no celular, conferindo o banco | Playwright usou Chromium r1194 do ambiente com mapeamento local (revisão diferente da que o Playwright baixa); a execução no CI do GitHub não existe até a cobrança ser resolvida |

## Decisões de produto abertas

1. Liberar a comissão V2 (`COMMISSION_V2_RELEASED=true`) e confirmar o mapeamento de papéis e a base de cálculo. Do Lucas.
2. Alçada de aprovação de renegociação (limite de desconto, quem aprova). Hoje: financeiro, e quem propôs não aprova.
3. O que fazer com cobrança remota de parcela encerrada (cancelar no Asaas): ação humana; o CRM não é dono do gateway.
