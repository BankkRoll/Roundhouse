-- Hand-written (ADR 0006 follow-ups): change set review, explicit service
-- edges, the per-environment approval rule and the per-workspace
-- `staged_changes` flag. No snapshot: the next generated migration diffs
-- against the schema source, not this file.

-- Review of a change set. `approved_revision` binds an approval to the
-- revision it covered; any later edit moves the set back to `submitted`.
ALTER TABLE `change_sets` ADD `review_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `submitted_by` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `submitted_at` integer;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `approved_revision` integer;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `rejected_by` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `rejected_at` integer;--> statement-breakpoint
ALTER TABLE `change_sets` ADD `review_note` text;--> statement-breakpoint
CREATE INDEX `change_sets_review_idx` ON `change_sets` (`project_id`,`review_status`,`status`);--> statement-breakpoint

-- "Connects to" edges drawn on the canvas. Services are soft-deleted, so
-- readers also filter on the services being live; the cascades cover a
-- project's hard delete.
CREATE TABLE `service_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_service_id` text NOT NULL,
	`to_service_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CHECK (`from_service_id` <> `to_service_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_edges_pair_uq` ON `service_edges` (`from_service_id`,`to_service_id`);--> statement-breakpoint
CREATE INDEX `service_edges_project_idx` ON `service_edges` (`project_id`);--> statement-breakpoint

-- Off by default so the upgrade changes nobody's workflow; project admins
-- opt a protected environment into required approvals.
ALTER TABLE `environments` ADD `require_approval` integer DEFAULT false NOT NULL;--> statement-breakpoint

-- Existing workspaces keep saving dashboard edits directly until someone
-- turns staging on in Settings; new workspaces are created with it on.
ALTER TABLE `workspaces` ADD `staged_changes` integer DEFAULT false NOT NULL;
