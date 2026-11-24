CREATE TABLE `auth_identities` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`provider` enum('telegram','google','discord','dev') NOT NULL,
	`subject` varchar(191) NOT NULL,
	`display_name` varchar(191),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `auth_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_identities_provider_subject_uq` UNIQUE(`provider`,`subject`)
);
--> statement-breakpoint
CREATE TABLE `identity_tombstones` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`provider` enum('telegram','google','discord','dev') NOT NULL,
	`subject_hash` char(64) NOT NULL,
	`is_banned` boolean NOT NULL DEFAULT false,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `identity_tombstones_id` PRIMARY KEY(`id`),
	CONSTRAINT `identity_tombstones_provider_hash_uq` UNIQUE(`provider`,`subject_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_seen_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	`user_agent` varchar(255),
	`ip` varchar(45),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`type` varchar(64) NOT NULL,
	`user_id` bigint unsigned,
	`entity_type` varchar(32),
	`entity_id` bigint unsigned,
	`payload` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nickname` varchar(32),
	`avatar_url` varchar(512),
	`birth_date` date,
	`birth_date_changed_at` datetime,
	`role` enum('owner','admin','moderator','user') NOT NULL DEFAULT 'user',
	`status` enum('pending','active','deleted') NOT NULL DEFAULT 'pending',
	`is_banned` boolean NOT NULL DEFAULT false,
	`timezone` varchar(64) NOT NULL DEFAULT 'Europe/Kyiv',
	`locale` varchar(8) NOT NULL DEFAULT 'uk',
	`privacy` json NOT NULL DEFAULT (json_object()),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_nickname_unique` UNIQUE(`nickname`)
);
--> statement-breakpoint
ALTER TABLE `auth_identities` ADD CONSTRAINT `auth_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `events_type_created_at_idx` ON `events` (`type`,`created_at`);