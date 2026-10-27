-- Phase 4: web shell sessions (ADR 0012, ADR 0014 §15) and the Cloudflare
-- Containers provider (ADR 0011). Written by hand from drizzle-kit output;
-- the schema snapshot is folded in when this lands on main.
CREATE TABLE `cf_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`script_name` text NOT NULL,
	`namespace_id` text,
	`application_id` text,
	`image_ref` text NOT NULL,
	`image_digest` text,
	`push_id` text,
	`runtime_generation` integer NOT NULL,
	`instance_type` text NOT NULL,
	`max_instances` integer NOT NULL,
	`route_ids` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cf_deployments_deployment_id_unique` ON `cf_deployments` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `cf_deployments_service_idx` ON `cf_deployments` (`service_id`,`environment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cf_deployments_push_idx` ON `cf_deployments` (`push_id`);--> statement-breakpoint
CREATE TABLE `cf_runtimes` (
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`script_name` text NOT NULL,
	`namespace_id` text,
	`application_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`route_ids` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`active_deployment_id` text,
	`disabled_at` integer,
	`delete_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `environment_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cf_runtimes_script_name_unique` ON `cf_runtimes` (`script_name`);--> statement-breakpoint
CREATE INDEX `cf_runtimes_delete_idx` ON `cf_runtimes` (`delete_after`) WHERE delete_after IS NOT NULL;--> statement-breakpoint
CREATE TABLE `shell_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`service_id` text NOT NULL,
	`workload_id` text NOT NULL,
	`deployment_id` text,
	`replica` integer NOT NULL,
	`node_id` text,
	`user_id` text,
	`token_id` text,
	`auth_session_id` text,
	`client_ip` text,
	`command` text NOT NULL,
	`container_user` text,
	`started_at` integer NOT NULL,
	`opened_at` integer,
	`ended_at` integer,
	`end_reason` text,
	`exit_code` integer,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shell_sessions_project_idx` ON `shell_sessions` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `shell_sessions_workspace_idx` ON `shell_sessions` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `shell_sessions_open_node_idx` ON `shell_sessions` (`node_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX `shell_sessions_open_user_idx` ON `shell_sessions` (`user_id`) WHERE ended_at IS NULL;