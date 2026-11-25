CREATE TABLE `game_staleness_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`kind` enum('stale_reminder','dead','suspicious') NOT NULL,
	`period_key` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `game_staleness_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `game_staleness_log_uq` UNIQUE(`game_id`,`kind`,`period_key`)
);
--> statement-breakpoint
ALTER TABLE `games` ADD `dead_at` datetime;--> statement-breakpoint
ALTER TABLE `games` ADD `dead_snoozed_until` datetime;--> statement-breakpoint
ALTER TABLE `games` ADD `dead_exempt_until_session` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `suspicious_at` datetime;--> statement-breakpoint
ALTER TABLE `games` ADD `suspicious_dismissed_until` datetime;--> statement-breakpoint
ALTER TABLE `games` ADD `closed_by_admin` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `game_staleness_log` ADD CONSTRAINT `game_staleness_log_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `games_dead_at_idx` ON `games` (`dead_at`);--> statement-breakpoint
CREATE INDEX `games_suspicious_at_idx` ON `games` (`suspicious_at`);