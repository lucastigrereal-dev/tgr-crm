ALTER TABLE `sales_commissions` ADD `reversalReviewStatus` enum('pending','resolved');--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `reversalReviewReason` text;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `reversalReviewRequestedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `reversalReviewResolvedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `reversalReviewResolvedByUserId` int;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD `reversalReviewNote` text;--> statement-breakpoint
ALTER TABLE `sales_commissions` ADD CONSTRAINT `sales_commissions_reversalReviewResolvedByUserId_users_id_fk` FOREIGN KEY (`reversalReviewResolvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;