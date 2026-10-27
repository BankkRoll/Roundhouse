-- Custom domains and TLS follow-ups (ADR 0009): per-domain HSTS and
-- certificate state, control-plane certificates for the `managed` TLS mode,
-- the ACME challenges being answered, certificate distribution to ingress
-- nodes, and the per-node certificate reports of the `acme` mode. Additive.
ALTER TABLE `domains` ADD `hsts` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tls_issuer` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tls_not_before` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `tls_not_after` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `tls_error` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `tls_updated_at` integer;--> statement-breakpoint
CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`hostnames` text NOT NULL,
	`kind` text NOT NULL,
	`challenge` text NOT NULL,
	`domain_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`key_sealed` text,
	`pending_key_sealed` text,
	`chain_pem` text,
	`sha256` text,
	`issuer` text,
	`not_before` integer,
	`not_after` integer,
	`renew_after` integer,
	`ari_cert_id` text,
	`order_url` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `certificates_domain_idx` ON `certificates` (`domain_id`);--> statement-breakpoint
CREATE INDEX `certificates_next_attempt_idx` ON `certificates` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `certificates_renew_after_idx` ON `certificates` (`renew_after`);--> statement-breakpoint
CREATE TABLE `acme_challenges` (
	`token` text PRIMARY KEY NOT NULL,
	`key_authorization` text NOT NULL,
	`certificate_id` text NOT NULL,
	`type` text NOT NULL,
	`dns_name` text,
	`dns_record_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`certificate_id`) REFERENCES `certificates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `acme_challenges_certificate_idx` ON `acme_challenges` (`certificate_id`);--> statement-breakpoint
CREATE INDEX `acme_challenges_expires_idx` ON `acme_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `certificate_deployments` (
	`certificate_id` text NOT NULL,
	`node_id` text NOT NULL,
	`sha256` text NOT NULL,
	`sent_at` integer NOT NULL,
	`acked_at` integer,
	PRIMARY KEY(`certificate_id`, `node_id`),
	FOREIGN KEY (`certificate_id`) REFERENCES `certificates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `certificate_deployments_node_idx` ON `certificate_deployments` (`node_id`);--> statement-breakpoint
CREATE TABLE `domain_tls_reports` (
	`domain_id` text NOT NULL,
	`node_id` text NOT NULL,
	`state` text NOT NULL,
	`issuer` text,
	`not_after` integer,
	`error` text,
	`reported_at` integer NOT NULL,
	PRIMARY KEY(`domain_id`, `node_id`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
