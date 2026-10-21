# DECISION_LOG

| Data | Decisão | Quem | Onde |
|---|---|---|---|
| 2026-10-21 | Comissão é paga sobre a ENTRADA INTEIRA efetivamente recebida, qualquer forma (débito, crédito, PIX), na 1ª ou 2ª parcela da entrada. `releaseOn: entry_total` é o ÚNICO default (legado, legacy-1 e versões, com ou sem flag); `first_entry_installment` só se explícito; `commercialPolicies.create` grava o releaseOn explícito. `COMMISSION_V2_RELEASED` segue travado. | Lucas | `docs/audit/ETAPA2_F2_ENTRADA_INTEIRA.md` |
