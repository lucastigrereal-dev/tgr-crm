CREATE INDEX `audit_logs_entity_type_idx` ON `audit_logs` (`entityType`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`id`);