CREATE TABLE `capture_sheet_settings` (
	`key` varchar(60) NOT NULL,
	`value` varchar(255) NOT NULL,
	`provisional` boolean NOT NULL DEFAULT true,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_sheet_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `maleSpouse` enum('titular','conjuge');--> statement-breakpoint
ALTER TABLE `capture_records` ADD `vehicleKind` enum('carro','moto');--> statement-breakpoint
ALTER TABLE `capture_records` ADD `secondVehicleKind` enum('carro','moto');--> statement-breakpoint
ALTER TABLE `capture_records` ADD `watchedVacationPresentation` boolean;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `captureKind` varchar(60);--> statement-breakpoint
ALTER TABLE `capture_sheet_settings` ADD CONSTRAINT `capture_sheet_settings_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT IGNORE INTO `capture_sheet_settings` (`key`, `value`, `provisional`) VALUES
	('nq_min_man_age', '30', true),
	('nq_min_relationship_months', '12', true),
	('nq_min_vehicle_year', '2018', true),
	('nq_min_income', '8000', true),
	('nq_max_items_accepted', '1', true),
	('min_presentation_minutes', '30', true),
	('brand_name', '', true);
--> statement-breakpoint
INSERT IGNORE INTO `capture_team_roles` (`code`, `label`, `kind`, `sortOrder`) VALUES
	('supervisor_vendas', 'Supervisor de vendas', 'presentation', 50);
