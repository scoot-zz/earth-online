CREATE TABLE `events_new` (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  lat REAL,
  lng REAL,
  region TEXT NOT NULL,
  category TEXT NOT NULL,
  breaking INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  impact TEXT NOT NULL,
  source TEXT NOT NULL,
  tz TEXT,
  occurred TEXT,
  province TEXT,
  source_type TEXT NOT NULL DEFAULT '国际',
  heat TEXT
);
--> statement-breakpoint
INSERT INTO `events_new` (id, edition_date, seq, title, city, country, lat, lng, region, category, breaking, summary, impact, source, tz, occurred)
SELECT id, edition_date, seq, title, city, country, lat, lng, region, category, breaking, summary, impact, source, tz, occurred FROM `events`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `events_new` RENAME TO `events`;
--> statement-breakpoint
CREATE INDEX events_edition_idx ON events (edition_date);
--> statement-breakpoint
ALTER TABLE `editions` ADD COLUMN `meta` text;
