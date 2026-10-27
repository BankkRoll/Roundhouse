ALTER TABLE `nodes` ADD `volume_quota` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `public_hostname` text;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `phase` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `prior_status` text;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `target_state` text;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `copied_bytes` integer;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `copy_finished_at` integer;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `copy_error` text;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `deployment_id` text REFERENCES deployments(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `cleanup_node_id` text REFERENCES nodes(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `cleanup_after` integer;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `cleanup_sent_at` integer;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `cleaned_at` integer;--> statement-breakpoint
ALTER TABLE `volume_migrations` ADD `started_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `volume_migrations_active_uq` ON `volume_migrations` (`volume_id`) WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `volume_migrations_target_idx` ON `volume_migrations` (`target_node_id`,`status`);--> statement-breakpoint
CREATE INDEX `volume_migrations_cleanup_idx` ON `volume_migrations` (`cleaned_at`,`cleanup_after`);--> statement-breakpoint
CREATE TABLE `tcp_proxies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`container_port` integer NOT NULL,
	`public_port` integer NOT NULL,
	`allowed_cidrs` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tcp_proxies_svc_env_uq` ON `tcp_proxies` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tcp_proxies_public_port_uq` ON `tcp_proxies` (`public_port`);--> statement-breakpoint
CREATE TABLE `credential_rotations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`principals` text NOT NULL,
	`applied` text DEFAULT '[]' NOT NULL,
	`secrets_sealed` text,
	`deploy` text NOT NULL,
	`change_set_id` text,
	`deployment_ids` text,
	`error` text,
	`requested_by` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`change_set_id`) REFERENCES `change_sets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_rotations_running_uq` ON `credential_rotations` (`service_id`,`environment_id`) WHERE status = 'running';--> statement-breakpoint
CREATE INDEX `credential_rotations_svc_env_idx` ON `credential_rotations` (`service_id`,`environment_id`,`id`);
