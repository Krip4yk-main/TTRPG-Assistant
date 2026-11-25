ALTER TABLE `game_members` MODIFY COLUMN `joined_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `game_members` MODIFY COLUMN `left_at` datetime(3);--> statement-breakpoint
ALTER TABLE `game_sessions` MODIFY COLUMN `done_at` datetime(3);