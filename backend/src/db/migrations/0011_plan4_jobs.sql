CREATE TABLE `jobs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`type` varchar(64) NOT NULL,
	`run_at` datetime(3) NOT NULL,
	`payload` json,
	`status` enum('pending','running','done','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`locked_until` datetime(3),
	`unique_key` varchar(191),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_unique_key_uq` UNIQUE(`unique_key`)
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_at_idx` ON `jobs` (`status`,`run_at`);