CREATE TABLE `content_warnings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(40) NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `content_warnings_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_warnings_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `game_systems` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(40) NOT NULL,
	`name` varchar(80) NOT NULL,
	`default_genre_id` bigint unsigned NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	CONSTRAINT `game_systems_id` PRIMARY KEY(`id`),
	CONSTRAINT `game_systems_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `genres` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(40) NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `genres_id` PRIMARY KEY(`id`),
	CONSTRAINT `genres_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `game_systems` ADD CONSTRAINT `game_systems_default_genre_id_genres_id_fk` FOREIGN KEY (`default_genre_id`) REFERENCES `genres`(`id`) ON DELETE no action ON UPDATE no action;