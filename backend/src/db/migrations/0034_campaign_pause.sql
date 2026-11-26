ALTER TABLE `games` MODIFY COLUMN `status` enum('draft','recruiting','started','paused','finished','cancelled') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `games` ADD `paused_at` datetime;--> statement-breakpoint
ALTER TABLE `games` ADD `pause_reason` enum('vacation','illness','study_work','other');--> statement-breakpoint
ALTER TABLE `games` ADD `pause_note` varchar(300);