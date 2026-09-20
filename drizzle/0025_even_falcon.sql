CREATE INDEX `captures_created_idx` ON `capture_records` (`createdAt`);--> statement-breakpoint
CREATE INDEX `contracts_proposal_status_idx` ON `contracts` (`proposalId`,`status`);--> statement-breakpoint
CREATE INDEX `financial_transactions_paid_idx` ON `financial_transactions` (`status`,`paidAt`,`type`);--> statement-breakpoint
CREATE INDEX `opportunities_period_idx` ON `opportunities` (`stage`,`closedAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `opportunities_campaign_period_idx` ON `opportunities` (`campaignId`,`stage`,`closedAt`);--> statement-breakpoint
CREATE INDEX `reservations_unit_status_dates_idx` ON `reservations` (`unitId`,`status`,`checkIn`,`checkOut`);--> statement-breakpoint
CREATE INDEX `commissions_source_installment_idx` ON `sales_commissions` (`sourceInstallmentId`,`status`);--> statement-breakpoint
CREATE INDEX `commissions_contract_status_idx` ON `sales_commissions` (`contractId`,`status`);