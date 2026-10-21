-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Motivo: hoje a parcela criada por um acordo e casada por contrato + valor proposto + vencimento proposto + sequencia posterior (heuristica em
-- entryInstallmentIds). Com a coluna, o vinculo vira exato e a heuristica passa a ser so fallback para acordos antigos (NULL).
ALTER TABLE `installment_renegotiations`
  ADD COLUMN `newInstallmentId` int NULL AFTER `originalInstallmentId`,
  ADD CONSTRAINT `reneg_new_installment_fk` FOREIGN KEY (`newInstallmentId`) REFERENCES `installments`(`id`),
  ADD INDEX `renegotiations_new_installment_idx` (`newInstallmentId`);
-- Backfill sugerido (revisar antes): preencher so quando houver exatamente 1 candidata pela mesma heuristica; ambiguos ficam NULL.
-- Codigo (futuro PR): applyRenegotiation grava newInstallmentId; entryInstallmentIds usa-o quando presente.
