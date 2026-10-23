CREATE TABLE `node_provisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`plan` text NOT NULL,
	`region` text NOT NULL,
	`builder` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`step` text,
	`failure_reason` text,
	`failure_message` text,
	`server_id` text,
	`ipv4` text,
	`ipv6` text,
	`join_token_id` text,
	`node_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`join_token_id`) REFERENCES `node_join_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `node_provisions_workspace_idx` ON `node_provisions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`token_sealed` text NOT NULL,
	`fingerprint` text NOT NULL,
	`token_last4` text NOT NULL,
	`account_label` text,
	`validated_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_ws_provider_uq` ON `provider_credentials` (`workspace_id`,`provider`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `provider_server_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `provider_server_missing_at` integer;