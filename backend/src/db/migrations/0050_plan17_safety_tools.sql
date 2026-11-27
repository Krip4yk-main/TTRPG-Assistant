CREATE TABLE `game_safety_topics` (
	`game_id` bigint unsigned NOT NULL,
	`warning_id` bigint unsigned NOT NULL,
	`kind` enum('line','veil') NOT NULL,
	CONSTRAINT `game_safety_topics_game_id_warning_id_pk` PRIMARY KEY(`game_id`,`warning_id`)
);
--> statement-breakpoint
ALTER TABLE `games` ADD `safety_tools` json DEFAULT (json_array()) NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `lines_custom` json DEFAULT (json_array()) NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `veils_custom` json DEFAULT (json_array()) NOT NULL;--> statement-breakpoint
ALTER TABLE `game_safety_topics` ADD CONSTRAINT `game_safety_topics_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_safety_topics` ADD CONSTRAINT `game_safety_topics_warning_id_content_warnings_id_fk` FOREIGN KEY (`warning_id`) REFERENCES `content_warnings`(`id`) ON DELETE no action ON UPDATE no action;