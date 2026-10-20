# Etapa 2, PR C1: administrativo autorizado valida a venda (sem gate de gerente)

- Validação oficial e conferência de comprovante: capacidades `sale.payment.confirm`, `sale.validate` (e `sale.documents.confer`/`sale.receipt.confer`, que o B1 usa) valem para `admin` e `finance`. `admin` sempre autorizado; `finance` só com concessão vigente em `sale_validator_grants` (migration 0072 PROPOSTA, com rollback `docs/rollback/0072_sale_validator_grants.down.sql`, não aplicada). Só admin concede e revoga (`saleValidation.grants.*`), com auditoria. Seller e service nunca.
- A mesma pessoa PODE conferir e validar (decisão 11 do titular). A trilha registra quem fez cada ato (`sale_validation_events`). Interruptor de segregação (`saleValidation.segregation.set`, só admin, trilha) DESLIGADO por padrão; ligado, quem conferiu o comprovante não valida a mesma venda (`SALE_SEGREGATION`).
- A validação final grava no `afterJson` o atestado ("Declaro ter conferido...") e `evidenceHash` (SHA-256 de documentRef + comprovante + nota). Sem coluna nova.
- Gate renomeado `managerValidated` -> `adminValidated` (alias `managerValidated` mantido por uma versão). Rótulo da tela: "Validação oficial (administrativo autorizado)"; botões só aparecem a quem o servidor aceitaria (`saleValidation.myAuthorization`).
- Contrato do evento `sale.validated` NÃO muda (`validatedBy` segue opaco).
- Testes reescritos (não desligados): `rbacMatrix` (finance permitido pela matriz, FORBIDDEN sem concessão), `saleValidation.test` (alias). Novos: `saleValidatorGrants.mysql.test` 3, `migrationRollback.mysql` até 0072.
- Teste-only: `testPumpLock.ts` (GET_LOCK) serializa os arquivos que usam o pump do Financial no banco compartilhado, que se atrapalhavam em paralelo (flaky).
