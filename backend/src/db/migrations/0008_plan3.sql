CREATE TABLE `ban_appeals` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`message` text NOT NULL,
	`ban_epoch` int NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ban_appeals_id` PRIMARY KEY(`id`),
	CONSTRAINT `ban_appeals_user_id_ban_epoch_uq` UNIQUE(`user_id`,`ban_epoch`)
);
--> statement-breakpoint
CREATE TABLE `application_constraint_responses` (
	`application_id` bigint unsigned NOT NULL,
	`constraint_id` varchar(16) NOT NULL,
	`response` enum('accepted','partial','cannot_guarantee') NOT NULL,
	`comment` varchar(500),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `application_constraint_responses_application_id_constraint_id_pk` PRIMARY KEY(`application_id`,`constraint_id`)
);
--> statement-breakpoint
CREATE TABLE `game_applications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`status` enum('pending','approved','rejected','withdrawn','cancelled') NOT NULL DEFAULT 'pending',
	`message` text,
	`answers` json NOT NULL,
	`constraints` json NOT NULL,
	`warnings_accepted_at` datetime NOT NULL,
	`cancel_reason` enum('age_rating','game_cancelled','banned'),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`decided_at` datetime,
	`decided_by` bigint unsigned,
	`active_key` varchar(41) GENERATED ALWAYS AS (IF(status = 'pending', CONCAT(game_id, ':', user_id), NULL)) VIRTUAL,
	CONSTRAINT `game_applications_id` PRIMARY KEY(`id`),
	CONSTRAINT `game_applications_active_key_uq` UNIQUE(`active_key`)
);
--> statement-breakpoint
CREATE TABLE `calendar_pinned_games` (
	`user_id` bigint unsigned NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `calendar_pinned_games_user_id_game_id_pk` PRIMARY KEY(`user_id`,`game_id`)
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` bigint unsigned NOT NULL,
	`calendar_autobusy` boolean NOT NULL DEFAULT true,
	CONSTRAINT `user_settings_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `game_bans` (
	`game_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `game_bans_game_id_user_id_pk` PRIMARY KEY(`game_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `gm_blacklist` (
	`gm_user_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `gm_blacklist_gm_user_id_user_id_pk` PRIMARY KEY(`gm_user_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`scope` enum('game_shared','game_private','session_private') NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`session_id` bigint unsigned,
	`session_key` bigint unsigned GENERATED ALWAYS AS (IFNULL(session_id, 0)) VIRTUAL,
	`user_id` bigint unsigned NOT NULL,
	`body` mediumtext NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `notes_scope_game_session_user_uq` UNIQUE(`scope`,`game_id`,`session_key`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `game_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`starts_at` datetime NOT NULL,
	`duration_minutes` smallint NOT NULL,
	`status` enum('scheduled','done','cancelled') NOT NULL DEFAULT 'scheduled',
	`origin` enum('rule','manual') NOT NULL,
	`rule_starts_at` datetime,
	`rescheduled` boolean NOT NULL DEFAULT false,
	`cancel_reason` varchar(300),
	`summary` text,
	`done_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `game_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `game_sessions_game_id_rule_starts_at_uq` UNIQUE(`game_id`,`rule_starts_at`)
);
--> statement-breakpoint
CREATE TABLE `session_attendance` (
	`session_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`present` boolean NOT NULL,
	CONSTRAINT `session_attendance_session_id_user_id_pk` PRIMARY KEY(`session_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `game_members` ADD `role` enum('player') DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE `game_members` ADD `application_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `game_members` ADD `left_at` datetime;--> statement-breakpoint
ALTER TABLE `game_members` ADD `left_reason` enum('left','kicked','banned');--> statement-breakpoint
ALTER TABLE `game_members` ADD `leave_note_gm` text;--> statement-breakpoint
ALTER TABLE `game_members` ADD `leave_note_admin` text;--> statement-breakpoint
ALTER TABLE `game_members` ADD `active` tinyint GENERATED ALWAYS AS (IF(left_at IS NULL, 1, NULL)) STORED;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_epoch` int DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Унікальний індекс створюємо до зняття складеного PK: він перебирає роль індексу для FK game_id.
ALTER TABLE `game_members` ADD CONSTRAINT `game_members_active_uq` UNIQUE(`game_id`,`user_id`,`active`);--> statement-breakpoint
ALTER TABLE `game_members` DROP PRIMARY KEY, ADD `id` bigint unsigned AUTO_INCREMENT NOT NULL FIRST, ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `ban_appeals` ADD CONSTRAINT `ban_appeals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `application_constraint_responses` ADD CONSTRAINT `acr_application_id_fk` FOREIGN KEY (`application_id`) REFERENCES `game_applications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_applications` ADD CONSTRAINT `game_applications_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_applications` ADD CONSTRAINT `game_applications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_applications` ADD CONSTRAINT `game_applications_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_pinned_games` ADD CONSTRAINT `calendar_pinned_games_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_pinned_games` ADD CONSTRAINT `calendar_pinned_games_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_settings` ADD CONSTRAINT `user_settings_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_bans` ADD CONSTRAINT `game_bans_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_bans` ADD CONSTRAINT `game_bans_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gm_blacklist` ADD CONSTRAINT `gm_blacklist_gm_user_id_users_id_fk` FOREIGN KEY (`gm_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gm_blacklist` ADD CONSTRAINT `gm_blacklist_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_sessions` ADD CONSTRAINT `game_sessions_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session_attendance` ADD CONSTRAINT `session_attendance_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session_attendance` ADD CONSTRAINT `session_attendance_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `game_applications_game_id_status_idx` ON `game_applications` (`game_id`,`status`);--> statement-breakpoint
CREATE INDEX `game_applications_user_id_idx` ON `game_applications` (`user_id`);--> statement-breakpoint
CREATE INDEX `calendar_pinned_games_game_id_idx` ON `calendar_pinned_games` (`game_id`);--> statement-breakpoint
CREATE INDEX `gm_blacklist_user_id_idx` ON `gm_blacklist` (`user_id`);--> statement-breakpoint
CREATE INDEX `notes_game_id_idx` ON `notes` (`game_id`);--> statement-breakpoint
CREATE INDEX `notes_user_id_idx` ON `notes` (`user_id`);--> statement-breakpoint
CREATE INDEX `game_sessions_game_id_starts_at_idx` ON `game_sessions` (`game_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `game_sessions_status_starts_at_idx` ON `game_sessions` (`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `session_attendance_user_id_idx` ON `session_attendance` (`user_id`);