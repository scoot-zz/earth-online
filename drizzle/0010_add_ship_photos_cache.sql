CREATE TABLE `ship_photos` (
	`mmsi` text PRIMARY KEY NOT NULL,
	`source_url` text,
	`page_url` text,
	`blob_key` text,
	`credit` text,
	`match` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
