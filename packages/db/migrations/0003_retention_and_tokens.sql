CREATE TABLE `consumed_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `consumed_nonces_expires_idx` ON `consumed_nonces` (`expires_at`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `token_prefix` text;--> statement-breakpoint
CREATE INDEX `log_chunks_last_ts_idx` ON `log_chunks` (`last_ts`);