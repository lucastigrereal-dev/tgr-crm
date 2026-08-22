CREATE INDEX `captures_vehicle_idx` ON `capture_records` (`vehicleBrand`,`vehicleModel`,`createdAt`);--> statement-breakpoint
CREATE INDEX `captures_profile_numeric_idx` ON `capture_records` (`childrenCount`,`averageIncome`,`createdAt`);--> statement-breakpoint
CREATE INDEX `captures_travel_idx` ON `capture_records` (`usualTravelSeason`,`travelWeeksPerYear`,`createdAt`);--> statement-breakpoint
CREATE INDEX `customers_location_idx` ON `customers` (`state`,`city`);