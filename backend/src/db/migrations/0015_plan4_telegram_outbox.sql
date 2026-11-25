CREATE TABLE `telegram_outbox` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`notification_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`chat_id` varchar(32) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`params` json NOT NULL,
	`buttons` json,
	`status` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`next_try_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`locked_until` datetime(3),
	`last_error` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `telegram_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegram_outbox_notification_id_uq` UNIQUE(`notification_id`)
);
--> statement-breakpoint
ALTER TABLE `telegram_outbox` ADD CONSTRAINT `telegram_outbox_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `telegram_outbox_status_next_try_at_idx` ON `telegram_outbox` (`status`,`next_try_at`);--> statement-breakpoint
CREATE INDEX `telegram_outbox_chat_id_status_idx` ON `telegram_outbox` (`chat_id`,`status`);--> statement-breakpoint
CREATE INDEX `telegram_outbox_updated_at_idx` ON `telegram_outbox` (`updated_at`);