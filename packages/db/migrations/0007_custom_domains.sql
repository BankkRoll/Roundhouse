-- Custom domains, direct mode (ADR 0009): lifecycle, ownership token, DNS
-- observations and the check schedule. Additive; existing generated domains
-- take the `active` default.
ALTER TABLE `domains` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `mode` text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `verification_token` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `apex` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `dns_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `ownership_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `dns_observed` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `error` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `check_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `pending_since` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `next_check_at` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `verified_at` integer;--> statement-breakpoint
CREATE INDEX `domains_next_check_idx` ON `domains` (`next_check_at`);
