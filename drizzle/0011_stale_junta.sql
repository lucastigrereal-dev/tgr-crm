CREATE TABLE `payment_gateway_customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`gatewayProvider` enum('asaas') NOT NULL,
	`gatewayCustomerId` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_gateway_customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_gateway_customer_unique` UNIQUE(`customerId`,`gatewayProvider`),
	CONSTRAINT `payment_gateway_external_unique` UNIQUE(`gatewayProvider`,`gatewayCustomerId`)
);
--> statement-breakpoint
CREATE TABLE `payment_gateway_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gatewayProvider` enum('asaas') NOT NULL,
	`gatewayEventId` varchar(128) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`billingRecordId` int,
	`processedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_gateway_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_gateway_webhook_unique` UNIQUE(`gatewayProvider`,`gatewayEventId`)
);
--> statement-breakpoint
ALTER TABLE `billing_records` ADD `gatewayProvider` enum('manual','asaas') DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_records` ADD `gatewayPaymentId` varchar(128);--> statement-breakpoint
ALTER TABLE `billing_records` ADD `gatewayStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `billing_records` ADD `pixQrCodeBase64` text;--> statement-breakpoint
ALTER TABLE `billing_records` ADD `invoiceUrl` text;--> statement-breakpoint
ALTER TABLE `billing_records` ADD `bankSlipUrl` text;--> statement-breakpoint
ALTER TABLE `billing_records` ADD `updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `payment_gateway_customers` ADD CONSTRAINT `payment_gateway_customers_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_gateway_webhook_events` ADD CONSTRAINT `payment_gateway_webhook_events_billingRecordId_billing_records_id_fk` FOREIGN KEY (`billingRecordId`) REFERENCES `billing_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `payment_gateway_webhook_billing_idx` ON `payment_gateway_webhook_events` (`billingRecordId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `billing_gateway_payment_idx` ON `billing_records` (`gatewayProvider`,`gatewayPaymentId`);--> statement-breakpoint
CREATE INDEX `billing_installment_status_idx` ON `billing_records` (`installmentId`,`status`);