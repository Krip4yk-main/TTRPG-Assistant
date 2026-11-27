ALTER TABLE `games` ADD `start_window_minutes` smallint;--> statement-breakpoint
ALTER TABLE `game_sessions` ADD `start_window_minutes` smallint;--> statement-breakpoint
ALTER TABLE `game_sessions` ADD `unpinned_reminded_at` datetime(3);