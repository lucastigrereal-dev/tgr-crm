# Runbook: ordem de ligar as flags do CRM

Estado: NADA aqui foi ligado e nenhuma migration PROPOSTA foi aplicada. Todas as flags abaixo nascem `false`. Este documento só diz **em que ordem** e **quem** liga. Ligar é decisão de quem está na última coluna, com GO do Opus quando houver migration.

## Ordem

1. **0079** (registro canônico do casal) aplicada.
2. **Resort mapeado (recomendado, não pré-requisito)**: ter a chave externa (`externalKey`) do projeto já cadastrada no empreendimento evita ambiguidade, mas o receptor de atendimento e a ponte de venda resolvem o resort pela mesma regra (`server/resortResolution.ts`): acham por chave e, se não houver, por nome, e nesse caso preenchem a `externalKey`. Só dá `422 UNKNOWN_PROJECT` quando faltam chave E nome, ou quando o nome já pertence a um resort mapeado para outra chave (conflito).
3. **Receptores do CRM** (Sales -> CRM).
4. **Flags do Sales** (lado Suite; só depois que o CRM já aceita o evento).
5. Demais fatias do CRM (admin, comissão, elegibilidade), cada uma na sua vez.

## Flag x migration proposta x vizinho x quem liga

| Flag (CRM) | Migration PROPOSTA que precisa estar aplicada | Vizinho | Quem liga |
|---|---|---|---|
| `ATTENDANCE_RECEIVER_ENABLED` | 0079 | Sales emite `encounter.attendance_recorded.v1`; Suite #142 e #144 mergeadas (o emissor é o #144, 155a3e6) | Lucas (GO), depois do passo 1 e 2 |
| `ENCOUNTER_TIMES_RECEIVER_ENABLED` | nenhuma | Sales emite `encounter.times_recorded.v1`; contrato aceito. Arquivo pinado pela Suite (`crm-extra-contracts.lock.json`) | Lucas |
| `NQ_READ_ENDPOINT_ENABLED` | nenhuma | Sales Command lê o NQ. Arquivo pinado pela Suite | Lucas (aceite) |
| `RECOVERY_ELIGIBILITY_ENABLED` | 0080 | Nenhum: não existe entrega ao Recovery (fatia 5). A mesma flag também abre a rota de ENTRADA de opt-out do Recovery (`registerRecoveryOptOutGate`/`Receiver`, exige `RECOVERY_INTEGRATION_KEY`) e liga o job de reconciliação da elegibilidade | Lucas, com GO do Opus |
| `RECOVERY_INTEGRATION_KEY` | 0080 (opt-out) | Recovery (opt-out). Só vale com a flag acima | Lucas |
| `OFFICIAL_INDICATOR_CATALOG_ENABLED` | 0081 | nenhum | admin do CRM (tela) |
| `COMMISSION_ROLE_MAP_ENABLED` | 0083 e `COMMISSION_V2_RELEASED=true` | nenhum (V2 é decisão do Lucas) | admin do CRM, depois do V2 |
| `FEATURE_FLAG_OVERRIDES_ENABLED` | 0084 | nenhum | admin técnico (fora da tela) |
| `PERMISSION_OVERRIDES_ENABLED` | 0085 | nenhum | admin técnico (fora da tela) |
| `SALE_VALIDATED_QUOTAS_COUNT_ENABLED` | nenhuma | Sales precisa aceitar `quotasCount` (Suite faz o re-pin do contrato) | Lucas, depois da Suite |
| `RESCUE_QUEUE_ENABLED` | 0086 | nenhum: MODO SOMBRA, só registra casos e eventos internos; nunca cancela contrato | Lucas (GO), fora da tela de flags |
| `AUTO_CANCELLATION_ENABLED` | (F4) | RESERVADA: o distrato automático real não existe; nenhum código age com ela | ninguém, por ora |
| `INVENTORY_HOLD_AT_FORMALIZATION` | nenhuma | Só depois de existir entrega de `contract.inventory_lost` ao Sales/Financial OU distrato automático | Lucas |

`COMMISSION_V2_RELEASED` continua travada e não passa por tela nenhuma.

## Coisas que precisam estar escritas

- **Só os horários de um casal sem ficha vão para DEAD.** O receptor de tempos (`encounter-times`) recusa código de casal sem ficha com `422 UNKNOWN_COUPLE_CODE` (não retentável; a entrega do Sales termina em DEAD). Os atendimentos (`encounter.attendance_recorded.v1`) NÃO: o receptor cria/atualiza `couple_registry` e aceita o casal sem ficha, desde que o projeto resolva um resort. A decisão de ligar o registro do casal à ficha (ATT-2 / CRM-2) é do Lucas e está **pendente**.
- **Ligar `RECOVERY_ELIGIBILITY_ENABLED` só grava eventos internos.** Nada chega ao Recovery: a entrega externa (fatia 5) não existe e exige contrato novo com a Suite. Ligar não "avisa" ninguém.
- **Várias instâncias: a mudança pela tela recarrega só o processo que atendeu o clique.** Flags que não pedem reinício (`restartRequired: false`) mudam na hora apenas nesse processo; as demais instâncias só enxergam depois de reiniciar. As flags de receptor/endpoint (lidas no boot) sempre pedem reinício.
- **A tela de flags exige a 0084 aplicada e `FEATURE_FLAG_OVERRIDES_ENABLED` ligada** (por quem tem acesso ao servidor). A aba de permissões é separada: exige a 0085 e `PERMISSION_OVERRIDES_ENABLED`. Sem a tabela da aba, ela mostra aviso de indisponível e nada é salvo.

## Antes de cada passo

1. Conferir que a migration correspondente foi aplicada por quem tem o GO (nunca pelo agente).
2. Ligar a flag no ambiente (ou pela tela, quando permitido) e reiniciar quando a flag pedir.
3. Conferir o efeito esperado e só então seguir para o próximo passo. Desligar a flag volta ao comportamento anterior; migration aplicada não é desfeita ao desligar.
