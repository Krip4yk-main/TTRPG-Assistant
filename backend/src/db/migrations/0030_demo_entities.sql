CREATE TABLE `demo_entities` (
	`entity_type` enum('user','game') NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `demo_entities_pk` PRIMARY KEY(`entity_type`,`entity_id`)
);
