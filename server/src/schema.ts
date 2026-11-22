// Local cache for city-card photos (全球天气 era). One row per place key
// (built-in city id, or a `sub:`-prefixed key for region-picker places):
// the Wikipedia lead image's bytes are downloaded once into blob storage
// (`blob_key`) so the card renders from this artifact's own origin
// instead of hotlinking upload.wikimedia.org — the live CDN fetch was
// unreliable on the user's phone network. `status` is 'ok' when a photo
// was cached, 'none' when the place's Wikipedia article has no usable
// lead image (card falls back to its weather-toned backdrop). Refreshed
// daily by the refreshCityPhotos action; getCityPhoto serves the cache
// first and only falls back to a live lookup for places with no row.
export const cityPhotos = sqliteTable("city_photos", {
  cityKey: text("city_key").primaryKey(),
  sourceUrl: text("source_url"),
  pageUrl: text("page_url"),
  blobKey: text("blob_key"),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Per-aircraft photo cache for the flight detail card (same pattern as
// city_photos: bytes owned in blob storage, never hotlinked). One row
// per ADS-B transponder hex, resolved lazily by getFlightPhoto ONLY
// when the user opens that aircraft's card — never pre-fetched for the
// ~1500 flights on the globe. `match` records what the photo actually
// depicts: 'aircraft' = this exact airframe (Planespotters, by
// registration or hex), 'type' = a same-type photo (Wikimedia Commons
// fallback) — the card labels the two honestly. Since edit #38 the
// chain leads with the full-size airport-data.com photo linked from
// the adsbdb aircraft record (also 'aircraft'; no photographer credit
// exists for it, so `credit` stays null and the card names
// airport-data.com as the source). `credit` carries the
// photographer / artist name for the card's attribution line. 'none'
// rows are negative cache, retried after 7 days (a plane with no photo
// today may be photographed tomorrow; city rows wait for the daily
// refresh instead).
export const flightPhotos = sqliteTable("flight_photos", {
  hex: text("hex").primaryKey(),
  sourceUrl: text("source_url"),
  pageUrl: text("page_url"),
  blobKey: text("blob_key"),
  credit: text("credit"),
  match: text("match", { enum: ["aircraft", "type"] }),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Per-callsign route cache for the flight detail card's 始发地/目的地
// fields. ADS-B positions carry no route, so the card's callsign is
// reverse-looked-up in the adsbdb public route database — ONLY for the
// one aircraft whose card is open, never pre-fetched for the layer.
// One row per callsign: origin/destination city (municipality), airport
// name and IATA code as adsbdb reports them; status 'none' when adsbdb
// has no route for the callsign (the card shows 未知 — routes are never
// invented). 'ok' rows are re-validated after 30 days (flight numbers
// get re-routed seasonally), 'none' rows after 7 days.
export const flightRoutes = sqliteTable("flight_routes", {
  callsign: text("callsign").primaryKey(),
  originCity: text("origin_city"),
  originName: text("origin_name"),
  originIata: text("origin_iata"),
  destCity: text("dest_city"),
  destName: text("dest_name"),
  destIata: text("dest_iata"),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Per-aircraft archive cache for the flight detail card's second info
// row （运营方 / registry country), resolved lazily by getFlightAircraft
// ONLY for the one aircraft whose card is open — never pre-fetched for
// the layer. One row per ADS-B transponder hex, from adsbdb's public
// aircraft database (https://api.adsbdb.com/v0/aircraft/<HEX>): full
// type variant, manufacturer, registration, registered owner/operator
// and the registry country as adsbdb reports them. NOTE (verified live
// 2026-11-18 against the adsb.lol feed, adsbdb, hexdb, the
// Planespotters photo API and the tar1090-db): none of the reachable
// free interfaces carries a manufacture year / first-flight date, so
// the card has no 机龄 field — the OpenSky metadata database that does
// carry one is unreachable from the server network. 'ok' rows
// re-validate after 30 days, 'none' rows after 7 days.
export const flightAircraft = sqliteTable("flight_aircraft", {
  hex: text("hex").primaryKey(),
  typeFull: text("type_full"),
  manufacturer: text("manufacturer"),
  registration: text("registration"),
  owner: text("owner"),
  ownerCountry: text("owner_country"),
  ownerCountryIso: text("owner_country_iso"),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Per-vessel photo cache for the ship detail card (same pattern as
// flight_photos: bytes owned in blob storage, never hotlinked). One
// row per MMSI, resolved lazily by getShipPhoto ONLY when the user
// opens that vessel's card — never pre-fetched for the ship layer.
// `match` records what the photo actually depicts: 'ship' = a
// Wikimedia Commons photo whose file title names this vessel,
// 'type' = a same-class photo (Commons fallback) — the card labels
// the two honestly. `credit` carries the photographer / artist name
// from the Commons extmetadata. 'none' rows are negative cache,
// retried after 7 days.
export const shipPhotos = sqliteTable("ship_photos", {
  mmsi: text("mmsi").primaryKey(),
  sourceUrl: text("source_url"),
  pageUrl: text("page_url"),
  blobKey: text("blob_key"),
  credit: text("credit"),
  match: text("match", { enum: ["ship", "type"] }),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// 地球Online · 每日大事 — data model (legacy news tables, no longer read).
//
// One row in `editions` per daily issue (Asia/Shanghai calendar date), with
// a `meta` JSON blob holding the production pipeline's real counts
// (collected / deduped / geolocated / categorized / published + per-source
// tallies) written by the research task that produced the issue.
// Each edition owns up to ~300 rows in `events`. Events with a confirmed
// location carry lat/lng and are plotted on the globe; unlocatable items
// keep lat/lng NULL, appear in the feed only, and are labeled 全国/多地 —
// coordinates are never invented. Old editions stay as the archive; a
// refresh replaces only its own date.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const editions = sqliteTable("editions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // YYYY-MM-DD, Asia/Shanghai calendar date of the issue.
  date: text("date").notNull().unique(),
  // One-line "今日世界速览" for the issue.
  headline: text("headline").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Pipeline metadata JSON (see EditionMeta in actions.ts). Nullable —
  // editions saved before the pipeline existed have none.
  meta: text("meta"),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  editionDate: text("edition_date").notNull(),
  // Display sequence within the edition (feed order tiebreak).
  seq: integer("seq").notNull(),
  title: text("title").notNull(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  // Nullable: only set when the location was confirmed by sources.
  lat: real("lat"),
  lng: real("lng"),
  region: text("region").notNull(),
  category: text("category", {
    enum: ["政治", "冲突", "灾害", "科技", "经济", "气候", "社会", "体育"],
  }).notNull(),
  // 1 = BREAKING (red), 0 = normal.
  breaking: integer("breaking").notNull().default(0),
  summary: text("summary").notNull(),
  impact: text("impact").notNull(),
  source: text("source").notNull(),
  // IANA timezone of the location, for the live local-time readout. Nullable.
  tz: text("tz"),
  // When the event happened, as reported by sources, in local terms
  // (e.g. "11月9日凌晨"). Nullable — never guessed, omitted when unknown.
  occurred: text("occurred"),
  // Chinese province (short name, e.g. 湖南) for China events. Nullable.
  province: text("province"),
  // Source class for the layer panel: 国际 wire copy, 热榜 trending lists,
  // 地方 local/provincial reporting.
  sourceType: text("source_type", {
    enum: ["国际", "热榜", "地方"],
  })
    .notNull()
    .default("国际"),
  // Trending rank / heat value as published by the source platform
  // (e.g. "第3位 · 热度 525427"). Nullable.
  heat: text("heat"),
  // 150–300字 detailed account distilled from the source reporting for the
  // detail panel. Nullable — editions saved before this field existed
  // fall back to the short summary in the UI.
  detail: text("detail"),
  // URL of the original report, only when the research task actually
  // opened it. Nullable — never reconstructed or guessed.
  sourceUrl: text("source_url"),
});
