ALTER TABLE `users` ADD `public_id` char(10);--> statement-breakpoint
UPDATE `users` SET `public_id` = REPLACE(REPLACE(SUBSTRING(MD5(CONCAT(`id`, RAND())), 1, 10), '0', 'g'), '1', 'h') WHERE `public_id` IS NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY `public_id` char(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_public_id_unique` UNIQUE(`public_id`);
