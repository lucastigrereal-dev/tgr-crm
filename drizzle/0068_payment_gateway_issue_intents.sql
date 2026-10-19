CREATE TABLE `payment_gateway_issue_intents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gatewayProvider` enum('asaas') NOT NULL,
	`installmentId` int NOT NULL,
	`type` enum('boleto','pix') NOT NULL,
	`externalReference` varchar(255) NOT NULL,
	`status` enum('pending','recorded','recovered','abandoned','manual_review') NOT NULL DEFAULT 'pending',
	`gatewayPaymentId` varchar(128),
	`attempts` int NOT NULL DEFAULT 0,
	`lastError` varchar(255),
	`actorUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_gateway_issue_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `pg_issue_intent_unique` UNIQUE(`gatewayProvider`,`installmentId`,`type`)
);
--> statement-breakpoint
CREATE INDEX `pg_issue_intent_status_idx` ON `payment_gateway_issue_intents` (`status`,`updatedAt`);