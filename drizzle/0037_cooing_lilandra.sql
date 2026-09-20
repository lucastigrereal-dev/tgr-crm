ALTER TABLE `billing_records` ADD `idempotencyKey` varchar(200);--> statement-breakpoint
ALTER TABLE `billing_records` ADD CONSTRAINT `billing_idempotency_unique` UNIQUE(`idempotencyKey`);