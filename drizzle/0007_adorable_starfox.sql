CREATE TABLE `proposal_discount_approvals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`requestedByUserId` int NOT NULL,
	`requestedAmount` decimal(14,2) NOT NULL,
	`approvedAmount` decimal(14,2),
	`discountPercent` decimal(5,2) NOT NULL,
	`rationale` text NOT NULL,
	`status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`decidedByUserId` int,
	`decisionNotes` text,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proposal_discount_approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales_playbooks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`stage` enum('new','qualified','proposal','negotiation','won','lost') NOT NULL,
	`guidance` text NOT NULL,
	`checklist` text,
	`active` boolean NOT NULL DEFAULT true,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_playbooks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `proposal_discount_approvals` ADD CONSTRAINT `proposal_discount_approvals_proposalId_proposals_id_fk` FOREIGN KEY (`proposalId`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_discount_approvals` ADD CONSTRAINT `proposal_discount_approvals_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_discount_approvals` ADD CONSTRAINT `proposal_discount_approvals_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales_playbooks` ADD CONSTRAINT `sales_playbooks_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `discount_proposal_status_idx` ON `proposal_discount_approvals` (`proposalId`,`status`);--> statement-breakpoint
CREATE INDEX `discount_requester_idx` ON `proposal_discount_approvals` (`requestedByUserId`,`status`);--> statement-breakpoint
CREATE INDEX `playbooks_stage_active_idx` ON `sales_playbooks` (`stage`,`active`);