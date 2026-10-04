CREATE TABLE `contract_signature_envelopes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contractId` int NOT NULL,
  `provider` varchar(32) NOT NULL DEFAULT 'clicksign',
  `externalEnvelopeId` varchar(128),
  `activeKey` varchar(160),
  `name` varchar(255) NOT NULL,
  `status` enum('draft','running','closed','canceled','error') NOT NULL DEFAULT 'draft',
  `lastEventName` varchar(120),
  `lastEventAt` timestamp NULL,
  `activatedAt` timestamp NULL,
  `closedAt` timestamp NULL,
  `canceledAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `contract_signature_envelopes_id` PRIMARY KEY(`id`),
  CONSTRAINT `signature_envelope_provider_external_unique` UNIQUE(`provider`,`externalEnvelopeId`),
  CONSTRAINT `signature_envelope_active_key_unique` UNIQUE(`activeKey`)
);
--> statement-breakpoint
CREATE INDEX `signature_envelope_contract_status_idx` ON `contract_signature_envelopes` (`contractId`,`status`);
--> statement-breakpoint
ALTER TABLE `contract_signature_envelopes` ADD CONSTRAINT `cse_contract_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `contract_signature_envelopes` ADD CONSTRAINT `cse_user_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `contract_signature_documents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `envelopeId` int NOT NULL,
  `contractDocumentId` int NOT NULL,
  `externalDocumentId` varchar(128) NOT NULL,
  `status` enum('pending','signed','closed','canceled') NOT NULL DEFAULT 'pending',
  `signedAt` timestamp NULL,
  `closedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `contract_signature_documents_id` PRIMARY KEY(`id`),
  CONSTRAINT `signature_document_envelope_contractdoc_unique` UNIQUE(`envelopeId`,`contractDocumentId`),
  CONSTRAINT `signature_document_external_unique` UNIQUE(`externalDocumentId`)
);
--> statement-breakpoint
ALTER TABLE `contract_signature_documents` ADD CONSTRAINT `csd_envelope_fk` FOREIGN KEY (`envelopeId`) REFERENCES `contract_signature_envelopes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `contract_signature_documents` ADD CONSTRAINT `csd_contractdoc_fk` FOREIGN KEY (`contractDocumentId`) REFERENCES `contract_documents`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `contract_signature_signers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `envelopeId` int NOT NULL,
  `customerId` int,
  `externalSignerId` varchar(128) NOT NULL,
  `name` varchar(180) NOT NULL,
  `email` varchar(320) NOT NULL,
  `documentation` varchar(32),
  `status` enum('pending','signed','refused','canceled') NOT NULL DEFAULT 'pending',
  `signedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `contract_signature_signers_id` PRIMARY KEY(`id`),
  CONSTRAINT `signature_signer_envelope_external_unique` UNIQUE(`envelopeId`,`externalSignerId`)
);
--> statement-breakpoint
CREATE INDEX `signature_signer_customer_status_idx` ON `contract_signature_signers` (`customerId`,`status`);
--> statement-breakpoint
ALTER TABLE `contract_signature_signers` ADD CONSTRAINT `css_envelope_fk` FOREIGN KEY (`envelopeId`) REFERENCES `contract_signature_envelopes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `contract_signature_signers` ADD CONSTRAINT `css_customer_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE `signature_webhook_events` (
  `id` int AUTO_INCREMENT NOT NULL,
  `provider` varchar(32) NOT NULL,
  `eventKey` varchar(160) NOT NULL,
  `eventName` varchar(120) NOT NULL,
  `externalEnvelopeId` varchar(128),
  `externalDocumentId` varchar(128),
  `payloadHash` varchar(64) NOT NULL,
  `occurredAt` timestamp NULL,
  `processedAt` timestamp NOT NULL DEFAULT (now()),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `signature_webhook_events_id` PRIMARY KEY(`id`),
  CONSTRAINT `signature_webhook_provider_event_unique` UNIQUE(`provider`,`eventKey`)
);
--> statement-breakpoint
CREATE INDEX `signature_webhook_envelope_created_idx` ON `signature_webhook_events` (`externalEnvelopeId`,`createdAt`);
