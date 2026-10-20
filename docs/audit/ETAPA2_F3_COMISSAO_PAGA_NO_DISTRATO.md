# ETAPA 2 · F3 · Comissão já paga em contrato distratado (onPaidCommissionCancellation)

Status: proposta, atrás de `COMMISSION_CANCEL_POLICY_ENABLED` (padrão false). Sem migração, sem evento/contrato novo. `COMMISSION_V2_RELEASED` intocada.

- Política (`commissionPolicy.onPaidCommissionCancellation`, versionável pelo F1): `manual_review` abre a fila manual do ADR-010 (hoje); `none` não abre fila e só grava auditoria informativa (`paid_commission_cancellation_noted`). NENHUM dos dois estorna, compensa ou faz clawback sozinho: comissão paga continua paga.
- Flag desligada: sempre `manual_review` (comportamento de hoje, testes ADR-010 inalterados). Ligada: vale a política vigente do empreendimento (`resolveCommissionPolicy`); sem política ou sem o campo, `none` (padrão da empresa, configurável).
- A decisão é lida dentro da transação do distrato. Comissões não pagas continuam sendo canceladas como antes.
- Testes: `commissionAdr010.mysql.test.ts` (none: sem fila, auditoria, comissão segue paga; manual_review: fila preservada) além dos existentes.
