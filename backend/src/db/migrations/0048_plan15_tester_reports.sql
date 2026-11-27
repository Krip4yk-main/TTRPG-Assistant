CREATE TABLE `tester_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`reporter_id` bigint unsigned,
	`kind` enum('bug','idea','other') NOT NULL,
	`text` varchar(4000) NOT NULL,
	`page_url` varchar(2048) NOT NULL,
	`theme` varchar(64) NOT NULL,
	`viewport_width` int unsigned NOT NULL,
	`viewport_height` int unsigned NOT NULL,
	`user_agent` varchar(512) NOT NULL,
	`status` enum('new','processed') NOT NULL DEFAULT 'new',
	`processed_by` bigint unsigned,
	`processed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tester_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tester_reports` ADD CONSTRAINT `tester_reports_reporter_id_users_id_fk` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tester_reports` ADD CONSTRAINT `tester_reports_processed_by_users_id_fk` FOREIGN KEY (`processed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tester_reports_status_id_idx` ON `tester_reports` (`status`,`id`);