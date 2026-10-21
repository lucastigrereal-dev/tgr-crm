# ETAPA 2 / F2 (correção): o que conta como entrada, retenção auditada e `releaseOn`

Dormente: só o motor V2 lê, e ele segue travado por `COMMISSION_V2_RELEASED`. Sem migration, sem evento novo, sem mudança de contrato.

- **Acumulado da entrada**: parcelas `cancelled` ficam fora. Parcela `renegotiated` ocupa a posição da original (valor original) e a parcela criada pelo acordo NÃO soma de novo: herda a condição de entrada da original (`installment_renegotiations.originalInstallmentId`, status `applied`). Renegociada sem parcela de acordo localizável fica fora.
- **Limite conhecido**: `installment_renegotiations` não guarda o id da parcela nova; ela é casada por contrato + valor proposto + vencimento proposto + sequência posterior. Pendência proposta (migration futura): coluna `newInstallmentId`.
- **Retenção auditada**: cada retenção do V2 grava `commission_v2_held` (idempotente por parcela + motivo): `payment_method_not_eligible`, `not_entry_installment`, `entry_total_not_reached`. Só auditoria, sem evento.
- **`payoutSchedule.releaseOn`** (só com `mode: full_upfront`): `first_entry_installment` (padrão atual, libera na primeira baixa elegível da entrada) ou `entry_total` (só quando o acumulado PAGO da entrada >= entryTotal). Qual é o padrão fica para o Lucas decidir.
- **Ressalva do `entry_total`**: se um acordo tiver desconto (parcela nova menor que a original), o acumulado pago pode nunca atingir entryTotal e a comissão ficaria retida. Decisão de negócio pendente (tolerar desconto aprovado ou não).
