ALTER TABLE `commercial_policy_versions` ADD `seededBy` varchar(40);--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `policyVersion` varchar(80);
--> statement-breakpoint
-- CRM-F1 (dados, idempotente): a política vigente hoje vira a versão `legacy-1` (vigência desde 2000-01-01), marcada seededBy para o rollback só apagar o que a migração criou. Só quem ainda não tem.
INSERT INTO `commercial_policy_versions` (`resortId`, `policyType`, `version`, `policyJson`, `effectiveAt`, `seededBy`)
SELECT s.`resortId`, 'commission', 'legacy-1', s.`commissionPolicy`, '2000-01-01 00:00:00', 'migration-0076-legacy'
FROM `commercial_project_settings` s
WHERE s.`commissionPolicy` IS NOT NULL AND TRIM(s.`commissionPolicy`) <> ''
  AND NOT EXISTS (SELECT 1 FROM `commercial_policy_versions` v WHERE v.`resortId` = s.`resortId` AND v.`policyType` = 'commission' AND v.`version` = 'legacy-1');
