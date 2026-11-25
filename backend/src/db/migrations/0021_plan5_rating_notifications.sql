ALTER TABLE `notifications` DROP INDEX `notifications_event_id_user_id_uq`;--> statement-breakpoint
ALTER TABLE `notifications` MODIFY COLUMN `category` enum('applications','members','sessions','reminders','games','ratings') NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_event_user_category_uq` UNIQUE(`event_id`,`user_id`,`category`);