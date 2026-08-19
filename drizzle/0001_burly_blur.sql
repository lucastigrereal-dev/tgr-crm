CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorUserId` int,
	`entityType` varchar(80) NOT NULL,
	`entityId` varchar(80) NOT NULL,
	`action` varchar(80) NOT NULL,
	`summary` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`installmentId` int NOT NULL,
	`type` enum('boleto','pix','card','transfer') NOT NULL DEFAULT 'boleto',
	`status` enum('pending','generated','paid','expired','cancelled') NOT NULL DEFAULT 'pending',
	`amount` decimal(14,2) NOT NULL,
	`dueDate` date NOT NULL,
	`externalReference` varchar(255),
	`digitableLine` varchar(255),
	`pixCopyPaste` text,
	`generatedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contract_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`category` varchar(80) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`storageKey` text NOT NULL,
	`signed` boolean NOT NULL DEFAULT false,
	`uploadedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contract_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`number` varchar(80) NOT NULL,
	`customerId` int NOT NULL,
	`proposalId` int,
	`sellerId` int,
	`usageModel` enum('fixed_week','flexible_week','points') NOT NULL DEFAULT 'fixed_week',
	`status` enum('draft','pending_signature','active','overdue','cancelled','closed') NOT NULL DEFAULT 'draft',
	`totalAmount` decimal(14,2) NOT NULL,
	`signedAt` timestamp,
	`activatedAt` timestamp,
	`cancelledAt` timestamp,
	`cancellationReason` text,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `contracts_number_unique` UNIQUE(`number`)
);
--> statement-breakpoint
CREATE TABLE `customer_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`type` varchar(80) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`storageKey` text NOT NULL,
	`uploadedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customer_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customer_interactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`type` enum('call','whatsapp','email','meeting','note') NOT NULL,
	`direction` enum('incoming','outgoing','internal') NOT NULL DEFAULT 'internal',
	`subject` varchar(255),
	`content` text NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`createdByUserId` int,
	CONSTRAINT `customer_interactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fullName` varchar(255) NOT NULL,
	`documentNumber` varchar(32),
	`email` varchar(320),
	`phone` varchar(32),
	`birthDate` date,
	`maritalStatus` varchar(48),
	`occupation` varchar(120),
	`zipCode` varchar(12),
	`address` varchar(255),
	`addressNumber` varchar(32),
	`complement` varchar(120),
	`neighborhood` varchar(120),
	`city` varchar(120),
	`state` varchar(2),
	`acquisitionSource` varchar(120),
	`status` enum('active','inactive','prospect') NOT NULL DEFAULT 'prospect',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int,
	`type` enum('income','expense') NOT NULL,
	`category` varchar(120) NOT NULL,
	`description` text NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`dueDate` date,
	`paidAt` timestamp,
	`status` enum('open','paid','cancelled') NOT NULL DEFAULT 'open',
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_transfers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int,
	`beneficiaryName` varchar(255) NOT NULL,
	`description` text,
	`amount` decimal(14,2) NOT NULL,
	`dueDate` date NOT NULL,
	`status` enum('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_transfers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `installments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contractId` int NOT NULL,
	`sequence` int NOT NULL,
	`dueDate` date NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`status` enum('open','paid','overdue','cancelled','renegotiated') NOT NULL DEFAULT 'open',
	`paidAt` timestamp,
	`paymentMethod` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `installments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`sellerId` int,
	`title` varchar(255) NOT NULL,
	`stage` enum('new','qualified','proposal','negotiation','won','lost') NOT NULL DEFAULT 'new',
	`source` varchar(120),
	`expectedAmount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`probability` int NOT NULL DEFAULT 10,
	`nextFollowUpAt` timestamp,
	`lossReason` text,
	`closedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `opportunities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`opportunityId` int NOT NULL,
	`reference` varchar(64) NOT NULL,
	`productDescription` text NOT NULL,
	`totalAmount` decimal(14,2) NOT NULL,
	`downPaymentAmount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`installmentCount` int NOT NULL DEFAULT 1,
	`status` enum('draft','sent','approved','rejected','expired') NOT NULL DEFAULT 'draft',
	`expiresAt` date,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`contractId` int,
	`unitId` int NOT NULL,
	`checkIn` date NOT NULL,
	`checkOut` date NOT NULL,
	`adults` int NOT NULL DEFAULT 1,
	`children` int NOT NULL DEFAULT 0,
	`status` enum('pending','confirmed','checked_in','completed','cancelled') NOT NULL DEFAULT 'pending',
	`notes` text,
	`createdByUserId` int,
	`checkedInAt` timestamp,
	`checkedOutAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `resorts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`city` varchar(120),
	`state` varchar(2),
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `resorts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales_goals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sellerId` int NOT NULL,
	`monthReference` date NOT NULL,
	`targetAmount` decimal(14,2) NOT NULL,
	`targetContracts` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sales_goals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`type` enum('follow_up','payment','reservation','service','internal') NOT NULL DEFAULT 'internal',
	`priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
	`status` enum('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
	`customerId` int,
	`contractId` int,
	`assignedToUserId` int,
	`dueAt` timestamp,
	`reminderAt` timestamp,
	`completedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resortId` int NOT NULL,
	`code` varchar(64) NOT NULL,
	`category` varchar(100),
	`capacity` int NOT NULL DEFAULT 2,
	`beds` int NOT NULL DEFAULT 1,
	`status` enum('active','maintenance','inactive') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `units_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','seller','finance','service','user') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_records` ADD CONSTRAINT `billing_records_installmentId_installments_id_fk` FOREIGN KEY (`installmentId`) REFERENCES `installments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_uploadedByUserId_users_id_fk` FOREIGN KEY (`uploadedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_proposalId_proposals_id_fk` FOREIGN KEY (`proposalId`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_sellerId_users_id_fk` FOREIGN KEY (`sellerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_documents` ADD CONSTRAINT `customer_documents_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_documents` ADD CONSTRAINT `customer_documents_uploadedByUserId_users_id_fk` FOREIGN KEY (`uploadedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_interactions` ADD CONSTRAINT `customer_interactions_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_interactions` ADD CONSTRAINT `customer_interactions_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD CONSTRAINT `financial_transactions_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD CONSTRAINT `financial_transactions_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_transfers` ADD CONSTRAINT `financial_transfers_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `installments` ADD CONSTRAINT `installments_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_sellerId_users_id_fk` FOREIGN KEY (`sellerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_opportunityId_opportunities_id_fk` FOREIGN KEY (`opportunityId`) REFERENCES `opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_unitId_units_id_fk` FOREIGN KEY (`unitId`) REFERENCES `units`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_goals` ADD CONSTRAINT `sales_goals_sellerId_users_id_fk` FOREIGN KEY (`sellerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_contractId_contracts_id_fk` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignedToUserId_users_id_fk` FOREIGN KEY (`assignedToUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `units` ADD CONSTRAINT `units_resortId_resorts_id_fk` FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `contracts_status_idx` ON `contracts` (`status`);--> statement-breakpoint
CREATE INDEX `contracts_customer_idx` ON `contracts` (`customerId`);--> statement-breakpoint
CREATE INDEX `interactions_customer_idx` ON `customer_interactions` (`customerId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`fullName`);--> statement-breakpoint
CREATE INDEX `customers_document_idx` ON `customers` (`documentNumber`);--> statement-breakpoint
CREATE INDEX `financial_transactions_status_idx` ON `financial_transactions` (`status`,`type`);--> statement-breakpoint
CREATE INDEX `installments_contract_idx` ON `installments` (`contractId`);--> statement-breakpoint
CREATE INDEX `installments_due_idx` ON `installments` (`status`,`dueDate`);--> statement-breakpoint
CREATE INDEX `opportunities_stage_idx` ON `opportunities` (`stage`);--> statement-breakpoint
CREATE INDEX `opportunities_seller_idx` ON `opportunities` (`sellerId`);--> statement-breakpoint
CREATE INDEX `reservations_unit_dates_idx` ON `reservations` (`unitId`,`checkIn`,`checkOut`);--> statement-breakpoint
CREATE INDEX `reservations_customer_idx` ON `reservations` (`customerId`);--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`status`,`dueAt`);--> statement-breakpoint
CREATE INDEX `tasks_assigned_idx` ON `tasks` (`assignedToUserId`);--> statement-breakpoint
CREATE INDEX `units_resort_code_idx` ON `units` (`resortId`,`code`);