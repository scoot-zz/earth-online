CREATE TABLE `flight_aircraft` (
	`hex` text PRIMARY KEY NOT NULL,
	`type_full` text,
	`manufacturer` text,
	`registration` text,
	`owner` text,
	`owner_country` text,
	`owner_country_iso` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
