ALTER TABLE `reservation_waitlist` ADD `activeKey` varchar(255);--> statement-breakpoint
ALTER TABLE `reservation_waitlist` ADD CONSTRAINT `waitlist_active_key_unique` UNIQUE(`activeKey`);