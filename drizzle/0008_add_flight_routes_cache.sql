CREATE TABLE `flight_routes` (
	`callsign` text PRIMARY KEY NOT NULL,
	`origin_city` text,
	`origin_name` text,
	`origin_iata` text,
	`dest_city` text,
	`dest_name` text,
	`dest_iata` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
