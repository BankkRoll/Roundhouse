CREATE TABLE `github_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_deliveries_created_idx` ON `github_deliveries` (`created_at`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `env_sealed` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `protocol_version` integer DEFAULT 1 NOT NULL;