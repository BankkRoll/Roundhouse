ALTER TABLE `restores` ADD `target_node_id` text REFERENCES nodes(id) ON DELETE set null;
