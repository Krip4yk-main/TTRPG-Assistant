CREATE TABLE `availability_busy_dates` (
	`user_id` bigint unsigned NOT NULL,
	`date` char(10) NOT NULL,
	CONSTRAINT `availability_busy_dates_user_id_date_pk` PRIMARY KEY(`user_id`,`date`)
);
--> statement-breakpoint
CREATE TABLE `availability_slots` (
	`user_id` bigint unsigned NOT NULL,
	`weekday` tinyint NOT NULL,
	`start_min` smallint NOT NULL,
	`end_min` smallint NOT NULL,
	CONSTRAINT `availability_slots_user_id_weekday_start_min_pk` PRIMARY KEY(`user_id`,`weekday`,`start_min`)
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` bigint unsigned NOT NULL,
	`bio` text,
	`city` varchar(80),
	`favorite_system_ids` json NOT NULL DEFAULT (json_array()),
	`preferred_formats` json NOT NULL DEFAULT (json_array()),
	`experience` enum('none','beginner','intermediate','veteran'),
	`privacy` json NOT NULL DEFAULT (json_object()),
	CONSTRAINT `user_profiles_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `availability_busy_dates` ADD CONSTRAINT `availability_busy_dates_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `availability_slots` ADD CONSTRAINT `availability_slots_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_profiles` ADD CONSTRAINT `user_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;