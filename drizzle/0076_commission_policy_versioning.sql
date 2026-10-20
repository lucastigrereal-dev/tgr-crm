ALTER TABLE `sales_commissions` ADD `policyVersion` varchar(80);
--> statement-breakpoint
-- CRM-F1 (dados, idempotente): a política vigente hoje vira a versão `legacy-1` (vigência desde 2000-01-01, anterior a qualquer versão nova). Só quem ainda não tem.
INSERT INTO `commercial_policy_versions` (`resortId`, `policyType`, `version`, `policyJson`, `effectiveAt`)
SELECT s.`resortId`, 'commission', 'legacy-1', s.`commissionPolicy`, '2000-01-01 00:00:00'
FROM `commercial_project_settings` s
WHERE s.`commissionPolicy` IS NOT NULL AND TRIM(s.`commissionPolicy`) <> ''
  AND NOT EXISTS (SELECT 1 FROM `commercial_policy_versions` v WHERE v.`resortId` = s.`resortId` AND v.`policyType` = 'commission' AND v.`version` = 'legacy-1');
