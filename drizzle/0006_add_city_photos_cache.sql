CREATE TABLE IF NOT EXISTS `city_photos` (
  `city_key` text PRIMARY KEY NOT NULL,
  `source_url` text,
  `page_url` text,
  `blob_key` text,
  `status` text NOT NULL,
  `updated_at` integer NOT NULL
);
