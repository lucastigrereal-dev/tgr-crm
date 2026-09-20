ALTER TABLE `audit_logs` ADD `idempotencyKey` varchar(200);--> statement-breakpoint
ALTER TABLE `domain_events` ADD `idempotencyKey` varchar(200);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_idempotency_unique` UNIQUE(`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `domain_events` ADD CONSTRAINT `domain_events_idempotency_unique` UNIQUE(`idempotencyKey`);