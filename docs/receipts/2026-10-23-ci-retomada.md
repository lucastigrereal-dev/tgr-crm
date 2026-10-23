# Recibo: retomada do CI (23/10/2026)

Entre 05:24Z e 10:38Z o GitHub Actions da conta ficou bloqueado por cobranca (annotation "account is locked due to a billing issue"
nos runs 07:17-07:19Z). As suites rodaram localmente (MySQL 8.0 descartavel). Depois do desbloqueio (Actions em 72% do orcamento),
este commit reabre a prova no head exato; so com CI verde nele o PR pode ser mergeado.

Flags seguem desligadas; nenhum banco real foi tocado.

Atualizacao 11:23Z: a trava era fatura/pagamento da conta; o Lucas regularizou as 11:12Z. Novo disparo unico apos a propagacao.

Atualizacao 11:40Z: novo disparo unico apos o "vai" do Lucas; se vier "account is locked" de novo, o motivo segue sendo a conta e nao o codigo.
