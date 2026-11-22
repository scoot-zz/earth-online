DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  headline TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  region TEXT NOT NULL,
  category TEXT NOT NULL,
  breaking INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  impact TEXT NOT NULL,
  source TEXT NOT NULL,
  tz TEXT
);
--> statement-breakpoint
CREATE INDEX events_edition_idx ON events (edition_date);
