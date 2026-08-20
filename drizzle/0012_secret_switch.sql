CREATE TABLE `capture_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`opportunityId` int,
	`campaignId` int,
	`promoterId` int,
	`linerId` int,
	`closerId` int,
	`salesRoom` varchar(180),
	`captureLocation` varchar(180),
	`lodgingLocation` varchar(180),
	`transportation` varchar(100),
	`isPasserby` boolean NOT NULL DEFAULT false,
	`scheduledAt` timestamp,
	`checkedInAt` timestamp,
	`presentationStatus` enum('captured','scheduled','checked_in','presented','no_tour','closed') NOT NULL DEFAULT 'captured',
	`qualificationStatus` enum('pending','qualified','disqualified') NOT NULL DEFAULT 'pending',
	`qualificationReason` text,
	`noTourReason` text,
	`partnerName` varchar(255),
	`partnerAge` int,
	`partnerProfession` varchar(120),
	`partnerProfessionNotes` text,
	`relationshipStatus` varchar(64),
	`relationshipYears` int,
	`relationshipMonths` int,
	`childrenCount` int NOT NULL DEFAULT 0,
	`childrenNames` text,
	`primaryProfessionNotes` text,
	`averageIncome` decimal(14,2),
	`vehicleBrand` varchar(100),
	`vehicleModel` varchar(120),
	`vehicleYear` int,
	`hasCreditCard` boolean,
	`creditCardBrands` text,
	`acceptsCheque` boolean,
	`ownsHome` boolean,
	`ownsPropertyInCity` boolean,
	`travelWeeksPerYear` decimal(4,1),
	`usualTravelSeason` varchar(180),
	`dreamTrips` text,
	`lastTrip` text,
	`averageHotelSpend` decimal(14,2),
	`nextFamilyTrip` text,
	`socialNetworks` text,
	`giftDescription` varchar(255),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_opportunityId_opportunities_id_fk` FOREIGN KEY (`opportunityId`) REFERENCES `opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_campaignId_sales_campaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `sales_campaigns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_promoterId_users_id_fk` FOREIGN KEY (`promoterId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_linerId_users_id_fk` FOREIGN KEY (`linerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_records` ADD CONSTRAINT `capture_records_closerId_users_id_fk` FOREIGN KEY (`closerId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `captures_customer_idx` ON `capture_records` (`customerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `captures_promoter_status_idx` ON `capture_records` (`promoterId`,`presentationStatus`,`createdAt`);--> statement-breakpoint
CREATE INDEX `captures_campaign_status_idx` ON `capture_records` (`campaignId`,`presentationStatus`);--> statement-breakpoint
CREATE INDEX `captures_opportunity_idx` ON `capture_records` (`opportunityId`);