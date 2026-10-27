-- Hand-written (ADR 0005): the WireGuard mesh between a workspace's nodes.
-- Each node's mesh index (its /24), its reported mesh state and key
-- rotation progress; each environment's nftables tag; each placement's mesh
-- IP; the pairs' preshared keys (sealed under the KEK) and paths. Additive.
-- No snapshot: the next generated migration diffs against the schema
-- source, not this file.

ALTER TABLE `nodes` ADD `mesh_index` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `wg_pubkey_next` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `wg_key_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `wg_key_next_epoch` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `wg_key_rotated_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_rotate_requested_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_rotate_generation` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_rotate_announced_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_activate_epoch` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_mode` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_nat` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_endpoint` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_endpoint_override` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_listen_port` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_docker_firewall` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_accept_fwmark` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_ready` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_error` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mesh_status_at` integer;--> statement-breakpoint
-- A removed node's index is free again; live nodes never share one.
CREATE UNIQUE INDEX `nodes_mesh_index_uq` ON `nodes` (`mesh_index`) WHERE `mesh_index` IS NOT NULL AND `deleted_at` IS NULL;--> statement-breakpoint

-- Assigned the first time an environment has a replica on a meshed node.
ALTER TABLE `environments` ADD `net_tag` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `environments_net_tag_uq` ON `environments` (`net_tag`) WHERE `net_tag` IS NOT NULL;--> statement-breakpoint

-- Cleared when the placement's deployment stops being live, so the address
-- can be handed to the next replica on the node.
ALTER TABLE `placements` ADD `mesh_ip` text;--> statement-breakpoint
CREATE UNIQUE INDEX `placements_node_mesh_ip_uq` ON `placements` (`node_id`,`mesh_ip`) WHERE `mesh_ip` IS NOT NULL;--> statement-breakpoint

CREATE TABLE `mesh_psks` (
	`pair_key` text PRIMARY KEY NOT NULL,
	`psk_sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mesh_paths` (
	`pair_key` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`relay_node_id` text,
	`configured_at` integer NOT NULL,
	`last_handshake_at` integer,
	`last_direct_attempt_at` integer,
	`sides` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`relay_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
