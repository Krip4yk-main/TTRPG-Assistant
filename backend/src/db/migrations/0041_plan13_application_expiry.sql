ALTER TABLE `game_applications` MODIFY COLUMN `status` enum('pending','approved','rejected','withdrawn','cancelled','expired') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `game_applications` ADD `reminded_at` datetime;--> statement-breakpoint
CREATE INDEX `game_applications_status_created_at_idx` ON `game_applications` (`status`,`created_at`);