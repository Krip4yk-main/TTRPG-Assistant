ALTER TABLE `polls` DROP FOREIGN KEY `polls_session_id_game_sessions_id_fk`;
--> statement-breakpoint
ALTER TABLE `polls` MODIFY COLUMN `close_reason` enum('all_voted','deadline','gm','game_closed');--> statement-breakpoint
ALTER TABLE `polls` ADD `applying_at` datetime(3);