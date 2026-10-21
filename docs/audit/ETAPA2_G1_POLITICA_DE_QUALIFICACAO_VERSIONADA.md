# ETAPA 2 / G1: política de qualificação (NQ) versionada

Flag: `QUALIFICATION_POLICY_VERSIONING_ENABLED` (padrão `false`). Migration PROPOSTA: `drizzle/0077_qualification_policy_versioning.sql` (rollback testado em `docs/rollback/0077_qualification_policy_versioning.down.sql`, nada aplicado em banco real).

## O que muda
- Nova tabela `qualification_policy_versions` (versão única, `paramsJson`, `effectiveAt`, `retiredAt`) e coluna `capture_records.nqPolicyVersion`.
- Parâmetros da versão (esquema estrito): idade mínima do homem, meses de relacionamento, ano mínimo do veículo, renda mínima, itens NQ aceitos, exigir cartão, exigir casa própria, tipos de veículo aceitos (`carro`, `moto`).
- Flag desligada: nada muda. Vale `capture_sheet_settings` como hoje; a resposta não ganha campo novo.
- Flag ligada: vale a versão vigente (a mais nova com `effectiveAt <= agora` e não encerrada). Sem versão vigente, vale o legado e o resultado sai com `policyVersion: "legacy"`. Versão ilegível no banco cai no legado e sai marcada `<versão>:invalid` (para o erro aparecer, sem travar a recepção).
- Sem retroatividade: `effectiveAt` nunca fica no passado (criação clampa para agora); a ficha guarda a versão que produziu o NT (`recordNt`) ou o resultado comercial (`recordCommercialOutcome`) e ela não muda depois.
- Admin: `captureSheet.settings.policies.list/create/retire`, com trilha de auditoria (`created`, `retired`).

## Contrato
O endpoint de leitura do NQ (já desligado por padrão) ganha o campo ADITIVO `nq.policyVersion`, somente com a flag ligada. Nenhum evento novo, nenhuma mudança no snapshot de contratos; sem re-pin. Consumidores que ignoram campos desconhecidos não são afetados.

## Pendências (não decididas aqui)
- Os valores das versões são decisão comercial; este PR não semeia nenhuma versão.
- O texto fixo do critério de veículo ("Carro dentro do ano mínimo") ainda diz carro mesmo quando a versão aceita moto.
