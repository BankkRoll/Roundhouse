CREATE TABLE `cron_states` (
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`next_run_at` integer,
	`last_scheduled_for` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `environment_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cron_states_next_idx` ON `cron_states` (`next_run_at`) WHERE next_run_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`deployment_id` text,
	`trigger` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`node_id` text,
	`workload_id` text,
	`exit_code` integer,
	`missed_count` integer,
	`error` text,
	`workflow_instance_id` text,
	`triggered_by` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_runs_slot_uq` ON `cron_runs` (`service_id`,`environment_id`,`scheduled_for`,`attempt`) WHERE "trigger" IN ('schedule', 'retry');--> statement-breakpoint
CREATE INDEX `cron_runs_svc_env_id_idx` ON `cron_runs` (`service_id`,`environment_id`,`id`);--> statement-breakpoint
CREATE INDEX `cron_runs_status_idx` ON `cron_runs` (`status`);--> statement-breakpoint
ALTER TABLE `service_configs` ADD `cron` text;--> statement-breakpoint
ALTER TABLE `log_chunks` ADD `cron_run_id` text REFERENCES cron_runs(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `log_chunks_cron_run_ts_idx` ON `log_chunks` (`cron_run_id`,`first_ts`);
