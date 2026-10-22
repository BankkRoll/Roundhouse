CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`service_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`commit_message` text,
	`commit_author` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`node_id` text,
	`image_repository` text NOT NULL,
	`image_digest` text,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `builds_deployment_idx` ON `builds` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `builds_service_id_idx` ON `builds` (`service_id`,`id`);--> statement-breakpoint
CREATE TABLE `deployment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployment_events_deployment_id_idx` ON `deployment_events` (`deployment_id`,`id`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`config_version` integer NOT NULL,
	`build_id` text,
	`image` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`triggered_by` text,
	`rollback_of` text,
	`workflow_instance_id` text,
	`failure_reason` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rollback_of`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deployments_svc_env_id_idx` ON `deployments` (`service_id`,`environment_id`,`id`);--> statement-breakpoint
CREATE INDEX `deployments_env_status_idx` ON `deployments` (`environment_id`,`status`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`hostname` text NOT NULL,
	`type` text NOT NULL,
	`target_port` integer NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`tls_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_hostname_unique` ON `domains` (`hostname`);--> statement-breakpoint
CREATE INDEX `domains_svc_env_idx` ON `domains` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `log_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text,
	`deployment_id` text,
	`build_id` text,
	`r2_key` text NOT NULL,
	`first_ts` integer NOT NULL,
	`last_ts` integer NOT NULL,
	`line_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `log_chunks_r2_key_unique` ON `log_chunks` (`r2_key`);--> statement-breakpoint
CREATE INDEX `log_chunks_service_ts_idx` ON `log_chunks` (`service_id`,`first_ts`);--> statement-breakpoint
CREATE INDEX `log_chunks_deployment_ts_idx` ON `log_chunks` (`deployment_id`,`first_ts`);--> statement-breakpoint
CREATE INDEX `log_chunks_build_ts_idx` ON `log_chunks` (`build_id`,`first_ts`);--> statement-breakpoint
CREATE TABLE `placements` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`replica` integer NOT NULL,
	`node_id` text NOT NULL,
	`workload_id` text NOT NULL,
	`container_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_status_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placements_workload_id_unique` ON `placements` (`workload_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placements_deployment_replica_uq` ON `placements` (`deployment_id`,`replica`);--> statement-breakpoint
CREATE INDEX `placements_node_idx` ON `placements` (`node_id`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`workspace_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installation_id_unique` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installations_workspace_idx` ON `github_installations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`pr_number` integer,
	`source_branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_slug_uq` ON `environments` (`project_id`,`slug`);--> statement-breakpoint
CREATE TABLE `project_keys` (
	`project_id` text PRIMARY KEY NOT NULL,
	`dek_sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_ws_slug_uq` ON `projects` (`workspace_id`,`slug`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `projects_workspace_id_idx` ON `projects` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `service_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_by` text,
	`source` text NOT NULL,
	`build` text NOT NULL,
	`deploy` text NOT NULL,
	`resources` text NOT NULL,
	`healthcheck` text,
	`networking` text NOT NULL,
	`placement` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_configs_svc_env_version_uq` ON `service_configs` (`service_id`,`environment_id`,`version`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'app' NOT NULL,
	`icon` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_project_slug_uq` ON `services` (`project_id`,`slug`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `services_project_id_idx` ON `services` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`service_id` text,
	`key` text NOT NULL,
	`value_sealed` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "variables_scope_ck" CHECK((scope = 'service' AND service_id IS NOT NULL) OR (scope = 'shared' AND service_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_service_key_uq` ON `variables` (`environment_id`,`service_id`,`key`) WHERE scope = 'service';--> statement-breakpoint
CREATE UNIQUE INDEX `variables_shared_key_uq` ON `variables` (`project_id`,`environment_id`,`key`) WHERE scope = 'shared';