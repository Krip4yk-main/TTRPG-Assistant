INSERT IGNORE INTO `genres` (`slug`, `sort`) VALUES
	('fantasy', 10),
	('dark-fantasy', 20),
	('horror', 30),
	('cyberpunk', 40),
	('scifi', 50),
	('postapoc', 60),
	('steampunk', 70),
	('noir', 80),
	('historical', 90),
	('superhero', 100),
	('comedy', 110);--> statement-breakpoint
INSERT IGNORE INTO `game_systems` (`slug`, `name`, `default_genre_id`, `sort`, `is_active`)
SELECT 'dnd5e-2014', 'D&D 5e (2014)', g.`id`, 10, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'dnd5e-2024', 'D&D 5e (2024)', g.`id`, 20, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'pf2e', 'Pathfinder 2e', g.`id`, 30, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'coc7e', 'Call of Cthulhu 7e', g.`id`, 40, 1 FROM `genres` g WHERE g.`slug` = 'horror'
UNION ALL
SELECT 'vtm-v5', 'Vampire: The Masquerade V5', g.`id`, 50, 1 FROM `genres` g WHERE g.`slug` = 'horror'
UNION ALL
SELECT 'cyberpunk-red', 'Cyberpunk RED', g.`id`, 60, 1 FROM `genres` g WHERE g.`slug` = 'cyberpunk'
UNION ALL
SELECT 'shadowrun6e', 'Shadowrun 6e', g.`id`, 70, 1 FROM `genres` g WHERE g.`slug` = 'cyberpunk'
UNION ALL
SELECT 'wfrp4e', 'Warhammer Fantasy Roleplay 4e', g.`id`, 80, 1 FROM `genres` g WHERE g.`slug` = 'dark-fantasy'
UNION ALL
SELECT 'blades', 'Blades in the Dark', g.`id`, 90, 1 FROM `genres` g WHERE g.`slug` = 'dark-fantasy'
UNION ALL
SELECT 'savage-worlds', 'Savage Worlds', g.`id`, 100, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'fate', 'Fate', g.`id`, 110, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'gurps', 'GURPS', g.`id`, 120, 1 FROM `genres` g WHERE g.`slug` = 'fantasy'
UNION ALL
SELECT 'mothership', 'Mothership', g.`id`, 130, 1 FROM `genres` g WHERE g.`slug` = 'scifi'
UNION ALL
SELECT 'uesrpg', 'UESRPG (The Elder Scrolls)', g.`id`, 140, 1 FROM `genres` g WHERE g.`slug` = 'fantasy';--> statement-breakpoint
INSERT IGNORE INTO `content_warnings` (`slug`, `sort`) VALUES
	('violence', 10),
	('gore', 20),
	('character-death', 30),
	('self-harm', 40),
	('sexual-content', 50),
	('drugs', 60),
	('phobias', 70),
	('abuse', 80),
	('discrimination', 90),
	('body-horror', 100);
