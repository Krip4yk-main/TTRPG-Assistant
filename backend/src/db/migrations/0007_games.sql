CREATE TABLE `game_content_warnings` (
	`game_id` bigint unsigned NOT NULL,
	`warning_id` bigint unsigned NOT NULL,
	CONSTRAINT `game_content_warnings_game_id_warning_id_pk` PRIMARY KEY(`game_id`,`warning_id`)
);
--> statement-breakpoint
CREATE TABLE `game_members` (
	`game_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`joined_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `game_members_game_id_user_id_pk` PRIMARY KEY(`game_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`gm_user_id` bigint unsigned NOT NULL,
	`title` varchar(120) NOT NULL,
	`description` text NOT NULL,
	`system_id` bigint unsigned,
	`system_other` varchar(80),
	`genre_id` bigint unsigned NOT NULL,
	`format` enum('online','offline') NOT NULL,
	`city` varchar(80),
	`address` varchar(255),
	`platform` varchar(60),
	`kind` enum('oneshot','campaign') NOT NULL,
	`starts_at` datetime NOT NULL,
	`duration_minutes` smallint NOT NULL,
	`recurrence` enum('none','weekly','biweekly','monthly') NOT NULL DEFAULT 'none',
	`weekdays` json NOT NULL DEFAULT (json_array()),
	`timezone` varchar(64) NOT NULL,
	`min_players` tinyint NOT NULL,
	`max_players` tinyint NOT NULL,
	`price_uah` int,
	`age_rating` enum('none','18+','21+') NOT NULL DEFAULT 'none',
	`experience` enum('any','beginner','experienced') NOT NULL DEFAULT 'any',
	`language` enum('uk','en') NOT NULL DEFAULT 'uk',
	`requirements` text,
	`cover_url` varchar(512),
	`channel_links` json NOT NULL DEFAULT (json_array()),
	`application_questions` json NOT NULL DEFAULT (json_array()),
	`custom_warnings` json NOT NULL DEFAULT (json_array()),
	`status` enum('draft','recruiting','started','finished','cancelled') NOT NULL DEFAULT 'draft',
	`show_when_full` boolean NOT NULL DEFAULT false,
	`published_at` datetime,
	`started_at` datetime,
	`finished_at` datetime,
	`cancelled_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `games_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `game_content_warnings` ADD CONSTRAINT `game_content_warnings_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_content_warnings` ADD CONSTRAINT `game_content_warnings_warning_id_content_warnings_id_fk` FOREIGN KEY (`warning_id`) REFERENCES `content_warnings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_members` ADD CONSTRAINT `game_members_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_members` ADD CONSTRAINT `game_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `games` ADD CONSTRAINT `games_gm_user_id_users_id_fk` FOREIGN KEY (`gm_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `games` ADD CONSTRAINT `games_system_id_game_systems_id_fk` FOREIGN KEY (`system_id`) REFERENCES `game_systems`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `games` ADD CONSTRAINT `games_genre_id_genres_id_fk` FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `game_members_user_id_idx` ON `game_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `games_status_starts_at_idx` ON `games` (`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `games_gm_user_id_idx` ON `games` (`gm_user_id`);