-- ADR 0004 data follow-ups: cleaning up a lost node's abandoned volume copy,
-- automatic recovery, and point-in-time recovery for Postgres. Written by
-- hand from drizzle-kit output; the schema snapshot is folded in when this
-- lands on main.
ALTER TABLE `volumes` ADD `abandoned_at` integer;--> statement-breakpoint
ALTER TABLE `volumes` ADD `cleaned_at` integer;--> statement-breakpoint
UPDATE `volumes` SET `abandoned_at` = `updated_at`, `delete_after` = `updated_at` + 259200000 WHERE `status` = 'abandoned' AND `abandoned_at` IS NULL;--> statement-breakpoint
CREATE INDEX `volumes_abandoned_idx` ON `volumes` (`status`,`cleaned_at`,`delete_after`);--> statement-breakpoint
CREATE TABLE `wal_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`volume_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`segment_count` integer DEFAULT 0 NOT NULL,
	`bytes_stored` integer DEFAULT 0 NOT NULL,
	`first_archived_at` integer,
	`last_archived_at` integer,
	`last_file` text,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wal_streams_active_uq` ON `wal_streams` (`service_id`,`environment_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `wal_streams_volume_idx` ON `wal_streams` (`volume_id`,`status`);--> statement-breakpoint
CREATE INDEX `wal_streams_svc_env_idx` ON `wal_streams` (`service_id`,`environment_id`,`id`);--> statement-breakpoint
CREATE TABLE `wal_segments` (
	`stream_id` text NOT NULL,
	`name` text NOT NULL,
	`size_raw` integer NOT NULL,
	`size_stored` integer NOT NULL,
	`sha256` text NOT NULL,
	`archived_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`stream_id`, `name`),
	FOREIGN KEY (`stream_id`) REFERENCES `wal_streams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wal_segments_archived_idx` ON `wal_segments` (`stream_id`,`archived_at`);--> statement-breakpoint
ALTER TABLE `backup_policies` ADD `pitr` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `wal_stream_id` text REFERENCES wal_streams(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `backups` ADD `wal_start` text;--> statement-breakpoint
ALTER TABLE `restores` ADD `trigger` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `restores` ADD `abandoned_volume_id` text REFERENCES volumes(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `restores` ADD `target_time` integer;--> statement-breakpoint
ALTER TABLE `restores` ADD `wal_end` text;--> statement-breakpoint
ALTER TABLE `restores` ADD `wal_files` integer;--> statement-breakpoint
CREATE TABLE `recovery_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`grace_minutes` integer DEFAULT 30 NOT NULL,
	`enabled_by` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`message` text,
	`lost_node_id` text,
	`restore_id` text,
	`triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enabled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lost_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`restore_id`) REFERENCES `restores`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_policies_svc_env_uq` ON `recovery_policies` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE INDEX `recovery_policies_enabled_idx` ON `recovery_policies` (`enabled`);
