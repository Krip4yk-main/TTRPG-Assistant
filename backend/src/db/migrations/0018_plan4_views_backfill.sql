-- Історичні дані не мають бути «новими»: майстер — його ж заявки на свої ігри; майстер і
-- активні учасники — наявні сесії. Час — момент міграції (пізніші зміни стануть «оновленням»).
INSERT IGNORE INTO `entity_views` (`user_id`, `entity_type`, `entity_id`, `viewed_at`)
SELECT g.`gm_user_id`, 'application', a.`id`, CURRENT_TIMESTAMP(3)
FROM `game_applications` a INNER JOIN `games` g ON g.`id` = a.`game_id`;--> statement-breakpoint
INSERT IGNORE INTO `entity_views` (`user_id`, `entity_type`, `entity_id`, `viewed_at`)
SELECT g.`gm_user_id`, 'session', s.`id`, CURRENT_TIMESTAMP(3)
FROM `game_sessions` s INNER JOIN `games` g ON g.`id` = s.`game_id`;--> statement-breakpoint
INSERT IGNORE INTO `entity_views` (`user_id`, `entity_type`, `entity_id`, `viewed_at`)
SELECT m.`user_id`, 'session', s.`id`, CURRENT_TIMESTAMP(3)
FROM `game_sessions` s INNER JOIN `game_members` m ON m.`game_id` = s.`game_id` AND m.`left_at` IS NULL;
