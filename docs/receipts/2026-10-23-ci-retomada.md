# Recibo: retomada do CI (23/10/2026)

Entre 05:24Z e 10:38Z o GitHub Actions da conta ficou bloqueado por cobranca (annotation "account is locked due to a billing issue"
nos runs 07:17-07:19Z). As suites rodaram localmente (MySQL 8.0 descartavel). Depois do desbloqueio (Actions em 72% do orcamento),
este commit reabre a prova no head exato; so com CI verde nele o PR pode ser mergeado.

Flags seguem desligadas; nenhum banco real foi tocado.
