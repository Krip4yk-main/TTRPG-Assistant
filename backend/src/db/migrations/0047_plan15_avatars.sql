ALTER TABLE `auth_identities` ADD `avatar_url` varchar(512);--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_source` enum('auto','google','discord','telegram','custom','none') DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `custom_avatar_url` varchar(512);--> statement-breakpoint
-- Первинне наповнення: аватар першої (не dev) ідентичності = поточний users.avatar_url; решта — при наступному вході.
UPDATE `auth_identities` `i`
JOIN (SELECT `user_id`, MIN(`id`) AS `first_id` FROM `auth_identities` GROUP BY `user_id`) `f` ON `f`.`first_id` = `i`.`id`
JOIN `users` `u` ON `u`.`id` = `i`.`user_id`
SET `i`.`avatar_url` = `u`.`avatar_url`
WHERE `i`.`provider` <> 'dev' AND `u`.`avatar_url` IS NOT NULL;
