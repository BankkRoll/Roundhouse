CREATE TABLE `metrics_samples` (
	`index1` text NOT NULL,
	`timestamp` integer NOT NULL,
	`blob1` text NOT NULL,
	`blob2` text DEFAULT '' NOT NULL,
	`blob3` text DEFAULT '' NOT NULL,
	`blob4` text DEFAULT '' NOT NULL,
	`blob5` text DEFAULT '' NOT NULL,
	`blob6` text DEFAULT '' NOT NULL,
	`blob7` text DEFAULT '' NOT NULL,
	`blob8` text DEFAULT '' NOT NULL,
	`blob9` text DEFAULT '' NOT NULL,
	`double1` real DEFAULT 0 NOT NULL,
	`double2` real DEFAULT 0 NOT NULL,
	`double3` real DEFAULT 0 NOT NULL,
	`double4` real DEFAULT 0 NOT NULL,
	`double5` real DEFAULT 0 NOT NULL,
	`double6` real DEFAULT 0 NOT NULL,
	`double7` real DEFAULT 0 NOT NULL,
	`double8` real DEFAULT 0 NOT NULL,
	`double9` real DEFAULT 0 NOT NULL,
	`double10` real DEFAULT 0 NOT NULL,
	`double11` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `metrics_samples_index_ts_idx` ON `metrics_samples` (`index1`,`blob1`,`timestamp`);--> statement-breakpoint
CREATE INDEX `metrics_samples_project_ts_idx` ON `metrics_samples` (`blob3`,`blob4`,`timestamp`);--> statement-breakpoint
CREATE INDEX `metrics_samples_ts_idx` ON `metrics_samples` (`timestamp`);