ALTER TABLE `csv_import_batches` ADD `sourceSystem` varchar(60) DEFAULT 'csv_manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `csv_import_batches` ADD `sourceFileName` varchar(255);--> statement-breakpoint
ALTER TABLE `csv_import_batches` ADD `contentHash` varchar(64);--> statement-breakpoint
ALTER TABLE `csv_import_items` ADD `sourceLine` int;--> statement-breakpoint
ALTER TABLE `csv_import_items` ADD `sourceRecordId` varchar(160);--> statement-breakpoint
ALTER TABLE `csv_import_items` ADD `rowHash` varchar(64);--> statement-breakpoint
CREATE INDEX `csv_batches_content_hash_idx` ON `csv_import_batches` (`contentHash`);--> statement-breakpoint
CREATE INDEX `csv_items_source_record_idx` ON `csv_import_items` (`sourceRecordId`);