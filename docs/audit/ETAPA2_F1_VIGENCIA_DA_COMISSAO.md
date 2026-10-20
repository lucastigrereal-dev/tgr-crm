# ETAPA 2 · F1 · Política de comissão por vigência

Status: proposta; flag `COMMISSION_POLICY_VERSIONING_ENABLED` DESLIGADA por padrão. Não toca no motor monetário: `COMMISSION_V2_RELEASED` continua ato do titular, as taxas padrão continuam 0%, nenhuma comissão positiva é liberada por este PR.

- Resolver único `server/commissionPolicyVersion.ts` (`resolveCommissionPolicy`) usado por baixa manual, webhook Asaas, reprocesso de janela 0% e validação. Com a flag ligada escolhe a versão `commercial_policy_versions` (`policyType='commission'`) com `effectiveAt <= data da parcela paga < retiredAt` (a mais recente); sem versão vigente, cai no legado `commercial_project_settings.commissionPolicy`. Versão vigente ilegível = sem política (o motor bloqueia como política ausente), nunca legado em silêncio. O reprocesso usa a política da data da parcela, não a de hoje.
- Flag desligada: comportamento idêntico ao anterior (só legado).
- `sales_commissions.policyVersion` (varchar 80, nulável) grava a versão aplicada ("legacy" para o legado). Desvio do desenho do gap: `ruleVersion` (v1/v2) NÃO foi ampliada porque a fixação v1/v2 por contrato depende dela; a versão da política vai em coluna própria.
- `commercialPolicies.create` com `policyType='commission'` valida a política com o mesmo parser do motor.
- Migração proposta 0076: colunas `policyVersion` e `commercial_policy_versions.seededBy` + dado idempotente `legacy-1` marcado `seededBy` (política atual de cada empreendimento, vigência 2000-01-01); o rollback apaga só as linhas semeadas. Rollback `docs/rollback/0076_commission_policy_versioning.down.sql`, testado sobe-desce-sobe. Nada aplicado.
- A tela de `projectSettings.upsert` continua gravando o legado; com a flag ligada e versões existentes ela deixa de valer (editar pela tela de versões). Aviso na UI fica para o F2/F3.
- Testes: `server/commissionPolicyVersion.mysql.test.ts` (flag off, vigência por data, versão ilegível fecha, criação validada, baixa grava `policyVersion`).

## Reprocesso da janela de 0% e vigência (parecer Opus)
- Com o versionamento ligado, o reprocesso da janela de 0% DEIXA de pagar com as taxas de hoje: cada parcela usa a política vigente na data do seu pagamento, e a semente `legacy-1` vale desde 2000-01-01 (a 0%, como o legado). Pagar a janela de 0% passa a ser ato explícito e auditado, em rodada própria (não neste PR). A mensagem de auditoria do reprocesso reflete isso ("com a política vigente na data do pagamento da parcela"); só com a flag desligada ela diz "com as taxas atuais".
- Vigência nunca retroativa: `commercialPolicies.create` recusa `effectiveAt` mais de 60 s no passado para `commission` (e `stock_hold`, por coerência) com BAD_REQUEST "A vigência não pode ser retroativa." Isso impede comissão retroativa sobre parcelas já pagas.
