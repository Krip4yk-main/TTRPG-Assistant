ALTER TABLE `notification_prefs` ADD `quiet_hours_enabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `quiet_hours_start` char(5) DEFAULT '23:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `quiet_hours_end` char(5) DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_outbox` ADD `silent` boolean DEFAULT false NOT NULL;