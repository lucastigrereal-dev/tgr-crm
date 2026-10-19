# ADR-012: aditivo contratual não monetário (CRM-A12)

Status: **especificação com padrão sensato; NÃO implementado** (nem atrás de flag). Só existe hoje o reajuste monetário (`contract_monetary_adjustments`). Aditivo como categoria de documento (`Aditivo`) existe apenas como anexo e NÃO conta como contrato assinado (`server/saleValidation.ts`).

## Por que só especificação

Implementar exige tabela nova, migração, máquina de estados, assinatura (Clicksign) do aditivo, regras de efeito sobre parcelas/cota e telas. Isso não cabe como "mínimo atrás de flag" sem decidir produto e jurídico; uma implementação parcial criaria um fluxo que parece valer e não vale. O CRM também não pode virar dono de nada que o Financial ou o Relationship já são donos.

## Escopo (padrão proposto)

Aditivo NÃO monetário altera dado do contrato que não muda valor: titular/co-titular, dados de contato/endereço, prazo de uso da cota, data de vigência, cláusula livre. Qualquer mudança de valor, parcela, desconto ou multa continua nos fluxos existentes (reajuste, renegociação, distrato) e é recusada no aditivo.

## Modelo proposto

Tabela `contract_addenda` (id, contractId, kind, status, requestedByUserId, reason, payload JSON de campos tocados com valor antes/depois, signedDocumentId nulo, createdAt, decidedAt). Estados: `draft` -> `awaiting_signature` -> `signed` | `cancelled`. Só `signed` produz efeito.

## Regras padrão (viram configuração com padrão, sem perguntar)

- `contract_addendum_enabled = false` (a funcionalidade nasce desligada).
- Efeito só com documento assinado vinculado (mesma regra do contrato: assinatura real, não só anexo).
- Mudança de titular exige documento do novo titular e passa pela fila de aprovação da administração.
- Todo aditivo grava trilha (`audit_logs`) com antes/depois e NÃO emite evento monetário. Evento para outros sistemas só com contrato de integração próprio (versionado, com fixture), nunca implícito.
- Comissão positiva continua TRAVADA; o aditivo nunca a destrava nem recalcula.

## Decisões humanas pendentes

1. Quais campos são aditiváveis (lista fechada).
2. Se o aditivo de titular é permitido ou exige distrato + novo contrato (jurídico).
3. Modelo de documento do aditivo e fluxo de assinatura.

## Plano de construção depois da decisão

Migração + rollback guardado (padrão 0061-0066), router com role `admin`/`finance`, testes MySQL (estado, trilha, recusa de valor, sem efeito antes da assinatura) e flag desligada até o jurídico aprovar.
