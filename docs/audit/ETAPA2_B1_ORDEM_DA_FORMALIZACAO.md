# Etapa 2, PR B1: ordem da formalização (flag desligada)

Proposta -> administrativo confere COMPROVANTE e DOCUMENTAÇÃO -> só então o contrato é gerado (documento de contrato, assinatura eletrônica) -> assinatura -> validação oficial.

- Flag `SALE_ORDER_GATE_ENABLED` (padrão **false**). `SALE_ORDER_GATE_SINCE` (ISO) isenta contratos criados antes (grandfathering do piloto). Ambas no compose do piloto (padrão desligado) com teste estático.
- Migration 0073 PROPOSTA (`sale_validations.documentsConferredAt/ByUserId/Note`), rollback `docs/rollback/0073_sale_documents_conferred.down.sql` testado em MySQL descartável. Comprovante conferido continua em `paymentConfirmed*` (sem renomear coluna).
- `saleValidation.confirmDocuments` (assertSaleValidator + capacidade `sale.documents.confer`; admin sempre, finance com concessão do C1). Sem evento para outro sistema: a trilha é a auditoria com ator e nota.
- Com a flag ligada: `contracts.uploadDocument` e `markDocumentSigned` (categoria contrato / contrato assinado), e `startContractElectronicSignature` recusam com `SALE_ORDER_GATE` até as duas conferências. Comprovante e aditivo seguem livres. O webhook do Clicksign NÃO é bloqueado (assinatura real não se perde).
- Validação final com a flag ligada: exige documentação conferida e que o contrato (documento de contrato ou envelope) tenha sido gerado depois das duas conferências (tolerância de 1 s do MySQL); senão `SALE_GATE_TIMESTAMP_INVALID`.
- Os portões (`gates`) e o evento `sale.validated` NÃO mudam (nenhum contrato novo, sem re-pin). A tela mostra o estado da ordem e o botão "Conferir documentação".
- Pendente (E1): a cota ainda é consumida em `contracts.create`; mudar isso (hold na formalização, `sold` só na conferência, 422 `INVENTORY_HELD_EXPIRED`) é o E1 e exige Suite -> CRM -> re-pin.
