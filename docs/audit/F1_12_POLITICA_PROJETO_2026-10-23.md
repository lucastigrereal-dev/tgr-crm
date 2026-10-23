# F1.12: política do projeto completa antes do 1º dia (23/10/2026)

Nada homologado. Somente leitura: nenhuma tabela nova, nenhuma flag nova, nenhuma migration.

## Problema

Na homologação (P3.6) a comissão V1 ficou bloqueada com `incomplete_project_policy` (`sales_commissions = 0`): o empreendimento tinha a política de comissão incompleta e ninguém conferiu antes de vender. O exemplo da tela de regras (`{"linerRate":0.02,"closerRate":0.03,"ftbRate":0.04}`) NÃO basta: o motor também exige `cancellationDeadlineDay`, `expectedPaymentDay`, `eligiblePaymentMethods` (ao menos um) e `basis: "eligible_receipt"`.

## O que existe agora

- `server/projectPolicyReadiness.ts`: checklist por empreendimento. Lê com as MESMAS regras dos motores (`resolveCommissionPolicy` para comissão, a política `sale_terms` vigente para a venda).
  - BLOQUEIA o dia 1: comissão V1 completa (`incomplete_project_policy`); condições da venda vigentes e únicas (`SALE_TERMS_POLICY_MISSING`, `SALE_TERMS_POLICY_AMBIGUOUS`, `SALE_TERMS_POLICY_INVALID`).
  - AVISA: percentuais todos em 0%; distrato sem multa/base/reembolso; sem documentos obrigatórios; sem cota disponível; sem chave do projeto do Sales.
- Admin: `projectSettings.readiness` (somente administração) e o cartão "Pronto para o 1º dia" na tela de regras do empreendimento.
- Antes do 1º dia, no servidor: `pnpm policy:readiness` (`--resort=ID`, `--json`). Sai com código 1 se algum empreendimento ativo tiver bloqueio ou se não houver empreendimento ativo; lê `DATABASE_URL`, nunca escreve.

## Provas

- `server/projectPolicyReadiness.test.ts`: o checklist concorda com `commissionBlockReason` do motor para política completa e para cada tipo de incompleta.
- `server/projectPolicyReadiness.mysql.test.ts`: MySQL descartável; política ausente / só percentuais = bloqueio `incomplete_project_policy`; sale_terms ausente, futura, ambígua e ilegível; versão vigente de comissão ilegível (versionamento ligado) bloqueia como o motor; só admin lê; o script sai 1/0.

## Contratos / re-pin

Nenhum: não toca em `encounterTimesReceiver.ts`, `nqReadEndpoint.ts`, snapshot nem `consumers.lock.json`.
