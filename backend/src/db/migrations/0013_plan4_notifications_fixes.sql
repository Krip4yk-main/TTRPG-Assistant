ALTER TABLE `events` ADD `dispatch_error` varchar(255);--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications` (`read_at`);