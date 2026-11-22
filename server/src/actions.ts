// Actions for 地球Online · 全球天气.
//
// The page is a live-weather globe. When the user lands on a city, the
// client calls getCityWeather with that city's coordinates and IANA
// timezone; the action fetches Open-Meteo (keyless, public) — the
// Forecast API for current conditions + today's sunrise/sunset, and the
// Air Quality API for PM2.5 / PM10 / US AQI — retrying with backoff on
// failure. Places picked from the region drill-down that have no single
// IANA zone of their own (US counties) pass tz "auto": Open-Meteo then
// resolves the zone from the coordinates and the action returns it as
// tzResolved so the card can show the true local clock. No numbers are
// ever invented: a failed fetch returns ok:false and the card shows an
// honest "数据暂不可用" state with a retry button.
//
// City photos are served from a LOCAL cache: refreshCityPhotos (run
// daily by cron, and once at ship time) downloads each built-in city's
// Wikipedia lead image into blob storage and records it in city_photos.
// getCityPhoto returns the cached blob URL first — the previous design
// hotlinked upload.wikimedia.org from the card, which repeatedly failed
// to load on the user's phone network. Only a place with no cache row
// at all falls back to a live Wikipedia lookup (whose bytes are then
// cached opportunistically for next time).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import * as satellite from "satellite.js";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { CITY_INDEX } from "./city-index";

const cityRef = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // An IANA zone ("Asia/Shanghai") or "auto" (Open-Meteo resolves the
  // zone from the coordinates — used for region-picker places like US
  // counties that carry no zone of their own).
  tz: z.string().min(3).max(60),
});

const weatherResponse = z.object({
  ok: z.boolean(),
  temperature: z.number().nullable(),
  apparentTemperature: z.number().nullable(),
  humidity: z.number().nullable(),
  weatherCode: z.number().nullable(),
  isDay: z.boolean().nullable(),
  windSpeed: z.number().nullable(),
  pressure: z.number().nullable(),
  precipitation: z.number().nullable(),
  pm25: z.number().nullable(),
  pm10: z.number().nullable(),
  usAqi: z.number().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
  observedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  // The IANA zone Open-Meteo resolved when the request used tz "auto";
  // null for requests that named their zone explicitly.
  tzResolved: z.string().nullable(),
  // True when the forecast call failed on Open-Meteo's daily quota
  // (HTTP 429) rather than a network fault — the card words its
  // failure state accordingly.
  quotaExceeded: z.boolean(),
});

const photoResponse = z.object({
  url: z.string().nullable(),
  pageUrl: z.string().nullable(),
});

const refreshPhotosResponse = z.object({
  ok: z.literal(true),
  total: z.number(),
  withPhoto: z.number(),
  withoutPhoto: z.number(),
  at: z.string(),
});

interface OmForecast {
  error?: boolean;
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    is_day?: number;
    wind_speed_10m?: number;
    surface_pressure?: number;
    precipitation?: number;
  };
  daily?: { sunrise?: string[]; sunset?: string[] };
}

interface OmAirQuality {
  error?: boolean;
  current?: { pm2_5?: number; pm10?: number; us_aqi?: number };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  // Open-Meteo's free tier throttles bursty callers intermittently (its
  // "daily limit" error also fires on per-minute bursts), so retry with
  // backoff: most transient rejections clear within a couple of seconds.
  // A 404 is NOT retried — the resource simply doesn't exist (a missing
  // Wikipedia article), and retrying it four times only delayed the
  // fallback chain by seconds.
  const delays = [700, 1600, 3000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "EarthOnline-GlobalWeather/1.0" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as T & { error?: boolean };
      if (data.error) throw new Error("upstream error payload");
      return data;
    } catch {
      const wait = delays[attempt];
      if (wait != null) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  return null;
}

// ── Weather fetch: parallel, independently timed, one retry ──────
// The old weather path used the generic fetchJson above: a 12s
// per-attempt timeout with three backoff retries, and — fatally —
// the action awaited BOTH Open-Meteo calls through Promise.all, so
// a slow/hanging AIR-QUALITY call (the CAMS model is the slow one
// for remote points: Sankuru in DR Congo, Markaz al Wahat in Egypt
// both timed out on device) held the whole card hostage for ~10s+
// and then failed it entirely, even when the forecast itself had
// long since succeeded. Now:
//   • both requests start in parallel, each with its OWN 6s timeout
//     and exactly ONE automatic retry (600ms later) on network
//     error — a single attempt is never allowed to hang past 6s;
//   • the forecast decides the card: success → card renders;
//   • air quality is awaited only within a 7s budget from request
//     start (withBudget): if it fails, times out or outlives the
//     budget, the card still renders with the PM/AQI fields null
//     (the UI shows those items as 暂无) — AQ can never fail or
//     stall the whole card again.
// Worst case for the card itself is the forecast's 6s + 0.6s + 6s;
// the typical remote-point case now resolves in the forecast's own
// latency (~1–3s) instead of the AQ tail latency.
// Quota-aware variant: Open-Meteo's free tier meters a DAILY call
// quota per egress IP (HTTP 429 "Daily API request limit exceeded").
// Retrying a 429 cannot succeed before the quota resets and only
// burns more of it, so a 429 short-circuits with quota:true and the
// caller can tell the user the real reason instead of a generic
// "unreachable". All other failures keep the one-retry behaviour.
async function fetchWeatherJsonQ<T>(
  url: string,
): Promise<{ data: T | null; quota: boolean }> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "EarthOnline-GlobalWeather/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 429) return { data: null, quota: true };
      if (res.status === 404) return { data: null, quota: false };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as T & { error?: boolean };
      if (data.error) throw new Error("upstream error payload");
      return { data, quota: false };
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  return { data: null, quota: false };
}

async function fetchWeatherJson<T>(url: string): Promise<T | null> {
  return (await fetchWeatherJsonQ<T>(url)).data;
}

// Resolve with the promise's value if it settles within `ms`, else
// null. The underlying request is left to finish in the background;
// its result is simply not awaited.
function withBudget<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// "2026-11-10T06:53" → "06:53" (already local time in the city's tz,
// because the forecast request passes timezone=<city tz>).
function hhmm(iso: string | undefined): string | null {
  if (!iso || iso.length < 16) return null;
  return iso.slice(11, 16);
}

// ── City photo resolution + local byte cache ─────────────────────────

interface WikiPageImages {
  query?: {
    pages?: Array<{
      missing?: boolean;
      thumbnail?: { source?: string };
      original?: { source?: string };
      fullurl?: string;
    }>;
  };
}

// Live Wikipedia lookup via the MediaWiki action API (prop=pageimages,
// pithumbsize=800). Why not the old REST summary + hand-swapped width:
// Wikimedia now refuses thumbnail widths that were not issued through
// its API ("400 Use thumbnail sizes listed…") — the previous build's
// /800px- string swap produced URLs the CDN rejects outright, which is
// why card photos silently never loaded for many cities. The API
// returns a sanctioned standard-size thumbnail URL (verified: fetches
// 200 image/jpeg). Falls back en → zh, thumbnail → original.
async function lookupWikiPhoto(
  wiki: string,
  zh: string,
): Promise<{ sourceUrl: string; pageUrl: string | null } | null> {
  const tries: Array<{ wikiHost: string; title: string }> = [
    { wikiHost: "en.wikipedia.org", title: wiki },
    { wikiHost: "zh.wikipedia.org", title: zh },
  ];
  for (const t of tries) {
    const url =
      `https://${t.wikiHost}/w/api.php?action=query` +
      "&prop=pageimages|info&piprop=thumbnail|original&pithumbsize=800" +
      `&inprop=url&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(t.title)}`;
    const data = await fetchJson<WikiPageImages>(url);
    const page = data?.query?.pages?.[0];
    if (!page || page.missing) continue;
    const img = page.thumbnail?.source ?? page.original?.source;
    if (img) {
      return {
        sourceUrl: img.split("?")[0] ?? img,
        pageUrl: page.fullurl ?? null,
      };
    }
  }
  return null;
}

// Download an image's bytes for the local cache. Returns null on any
// failure or when the payload isn't a sane-sized image.
async function downloadImage(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "EarthOnline-GlobalWeather/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 2000 || buf.length > 3_000_000) return null;
    return { bytes: buf, contentType };
  } catch {
    return null;
  }
}

// Resolve one place's photo and persist it in the local cache. When the
// article's lead image hasn't changed and a blob already exists, the
// bytes are kept (the daily refresh stays cheap).
async function cachePlacePhoto(
  ctx: Ctx,
  key: string,
  wiki: string,
  zh: string,
): Promise<"ok" | "none"> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.cityPhotos)
    .where(eq(schema.cityPhotos.cityKey, key))
    .get();
  const found = await lookupWikiPhoto(wiki, zh);
  if (!found) {
    await db
      .insert(schema.cityPhotos)
      .values({
        cityKey: key,
        sourceUrl: null,
        pageUrl: null,
        blobKey: null,
        status: "none",
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.cityPhotos.cityKey,
        set: {
          sourceUrl: null,
          pageUrl: null,
          blobKey: null,
          status: "none",
          updatedAt: Date.now(),
        },
      });
    return "none";
  }
  let blobKey = existing?.blobKey ?? null;
  if (!blobKey || existing?.sourceUrl !== found.sourceUrl) {
    const dl = await downloadImage(found.sourceUrl);
    if (dl) {
      blobKey = `city-photos/${key.replace(/[^a-z0-9-]+/gi, "_")}`;
      await ctx.blobs.put(blobKey, dl.bytes, {
        contentType: dl.contentType,
      });
    }
    // Download failed (transient): keep any previous blob; with none,
    // the row still records the source URL so getCityPhoto can hand it
    // out as a last-resort live link, and the next refresh retries.
  }
  await db
    .insert(schema.cityPhotos)
    .values({
      cityKey: key,
      sourceUrl: found.sourceUrl,
      pageUrl: found.pageUrl,
      blobKey,
      status: "ok",
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: schema.cityPhotos.cityKey,
      set: {
        sourceUrl: found.sourceUrl,
        pageUrl: found.pageUrl,
        blobKey,
        status: "ok",
        updatedAt: Date.now(),
      },
    });
  return "ok";
}

// ── Reverse geocoding (tap-anywhere naming) ──────────────────────────
//
// The globe lets the user tap ANY point — a village, a county the
// picker doesn't list, open ocean — and asks "what is this place?".
// Names come from the BigDataCloud free reverse-geocode API (keyless,
// built for exactly this): it returns the locality, the first-level
// admin region (principalSubdivision) and the country in Chinese for
// the exact coordinates. Nothing is guessed client-side: when the
// service can't name the point, ok:false comes back and the card falls
// back to showing the raw coordinates.

const pointRef = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const geocodeResponse = z.object({
  ok: z.boolean(),
  // Most specific locality name the service knows (city / locality),
  // null when the point has no named locality (open ocean, wilderness).
  name: z.string().nullable(),
  // First-level admin region (province/state), null when unknown.
  region: z.string().nullable(),
  country: z.string().nullable(),
});

interface BdcReverse {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryName?: string;
}

async function fetchBdc(url: string): Promise<BdcReverse | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "EarthOnline-GlobalWeather/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BdcReverse;
  } catch {
    return null;
  }
}

function cleanName(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

// ── Mapillary street-level imagery ──────────────────────────────────
//
// A Mapillary client token from the MAPILLARY_TOKEN environment
// variable (read-only public token,
// supplied by the user for exactly this feature). It lives ONLY in
// this server module: the client never sees it — the browser asks
// getStreetView for a coordinate and gets back one image's URL and
// metadata. Mapillary imagery is CC BY-SA; the card carries the
// required "© Mapillary 贡献者 · CC BY-SA" attribution.
//
// Lookup strategy (per the user's approved plan): query a ±0.0015°
// bbox (≈150 m) around the point first; if nothing usable comes
// back, widen once to ±0.005° (≈500 m). From the candidates, prefer
// the nearest panorama (is_pano); with no panorama, take the nearest
// photo. Any failure — network, timeout, empty — returns found:false
// and the card simply shows 附近暂无街景实拍; street view can never
// fail or stall the weather card (same degrade-only principle as the
// air-quality path).
//
// Fetch shape (measured, not assumed): a single bbox query asking
// for the signed thumb URLs of all 20 hits took ~18s for Times
// Square from the server network (sparse Beijing: ~3s) — the
// per-image URL signing dominates. So the lookup is two-stage: the
// bbox query asks only for selection metadata (id, is_pano,
// computed_geometry, captured_at — ~10s worst case in the densest
// city, ~1s in sparse areas), then the winning image's thumbs are
// fetched from the single-image endpoint (~0.5s). Timeouts are
// sized to those measurements (20s / 6s); the street-view query
// loads independently inside the card, so this budget never stalls
// the weather itself.
//
// Delivery (also measured): the signed thumb URLs are bound to the
// network context that called the API — a URL issued to this
// server returns 403 when fetched from any other network (the
// user's phone included), while the SAME context that obtained it
// downloads 200 image/jpeg. Handing the raw URL to the client would
// therefore show a broken image everywhere. Instead the action
// downloads the winning image's bytes itself and caches them in
// blob storage under streetview/<imageId>; the client renders the
// blob URL (this artifact's own origin, like the Wikipedia photo
// cache). Street photos are immutable, so the byte cache never
// needs invalidating — repeat opens skip straight to the blob.

const MAPILLARY_TOKEN = process.env.MAPILLARY_TOKEN ?? "";

const streetViewResponse = z.object({
  found: z.boolean(),
  imageUrl: z.string().nullable(),
  distanceM: z.number().nullable(),
  capturedAt: z.string().nullable(),
  isPano: z.boolean().nullable(),
  imageId: z.string().nullable(),
});

interface MlyImageMeta {
  id?: string;
  is_pano?: boolean;
  computed_geometry?: { coordinates?: [number, number] };
  captured_at?: number;
}

interface MlyImagesResponse {
  data?: MlyImageMeta[];
}

interface MlyThumbs {
  thumb_1024_url?: string;
  thumb_2048_url?: string;
}

// Stage 1: selection metadata for the bbox's images (no thumb URLs —
// signing 20 of them is what made the one-shot query take ~18s).
async function fetchMlyImageMeta(
  lat: number,
  lng: number,
  halfDeg: number,
): Promise<MlyImageMeta[]> {
  const minLat = Math.max(-90, lat - halfDeg);
  const maxLat = Math.min(90, lat + halfDeg);
  const minLng = Math.max(-180, lng - halfDeg);
  const maxLng = Math.min(180, lng + halfDeg);
  const url =
    "https://graph.mapillary.com/images" +
    "?fields=id,is_pano,computed_geometry,captured_at" +
    `&bbox=${minLng},${minLat},${maxLng},${maxLat}&limit=20`;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "EarthOnline-GlobalWeather/1.0",
        // The token travels in the Authorization header, never in
        // the URL (query strings leak into request logs / referrers).
        authorization: `Bearer ${MAPILLARY_TOKEN}`,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as MlyImagesResponse;
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

// Stage 2: the chosen image's display URL (2048 thumb preferred,
// 1024 fallback), from the single-image endpoint.
async function fetchMlyThumb(imageId: string): Promise<string | null> {
  const url =
    `https://graph.mapillary.com/${encodeURIComponent(imageId)}` +
    "?fields=thumb_2048_url,thumb_1024_url";
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "EarthOnline-GlobalWeather/1.0",
        authorization: `Bearer ${MAPILLARY_TOKEN}`,
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MlyThumbs;
    return data.thumb_2048_url ?? data.thumb_1024_url ?? null;
  } catch {
    return null;
  }
}

// Great-circle distance in metres between two lat/lng points.
function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── v2.0 live-Earth layers: USGS earthquakes, NASA EONET natural
// events, RainViewer radar/satellite frames, global extremes ────────
//
// Every upstream here is keyless and public. Each fetch carries its
// own hard timeout and the actions degrade per-source (an ok flag +
// empty list), because the globe must never block or fail on any of
// them: the client hides a failed layer silently with a small note.

async function fetchFastJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "EarthOnline-GlobalWeather/2.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface UsgsFeed {
  features?: Array<{
    id?: string;
    properties?: {
      mag?: number;
      place?: string;
      time?: number;
      url?: string;
    };
    geometry?: { coordinates?: number[] };
  }>;
}

interface EonetFeed {
  events?: Array<{
    id?: string;
    title?: string;
    link?: string;
    categories?: Array<{ id?: string }>;
    sources?: Array<{ url?: string }>;
    geometry?: Array<{
      date?: string;
      type?: string;
      coordinates?: number[];
    }>;
  }>;
}

interface RainViewerMaps {
  host?: string;
  radar?: { past?: Array<{ time?: number; path?: string }> };
  satellite?: { infrared?: Array<{ time?: number; path?: string }> };
}

interface OmBulkCurrent {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    precipitation?: number;
    pm2_5?: number;
    us_aqi?: number;
  };
}

const quakeSchema = z.object({
  id: z.string(),
  mag: z.number(),
  depth: z.number().nullable(),
  place: z.string(),
  time: z.number(),
  lat: z.number(),
  lng: z.number(),
  url: z.string().nullable(),
});

const natEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  date: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  link: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});

const earthEventsResponse = z.object({
  quakesOk: z.boolean(),
  eventsOk: z.boolean(),
  quakes: z.array(quakeSchema).max(200),
  events: z.array(natEventSchema).max(300),
  fetchedAt: z.string(),
});

type QuakeOut = z.infer<typeof quakeSchema>;
type NatEventOut = z.infer<typeof natEventSchema>;

const rainFrameSchema = z.object({ time: z.number(), path: z.string() });

const rainViewerResponse = z.object({
  ok: z.boolean(),
  host: z.string().nullable(),
  radarPast: z.array(rainFrameSchema).max(40),
  satellite: z.array(rainFrameSchema).max(40),
  fetchedAt: z.string(),
});

const extremesRequest = z.object({
  points: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .min(1)
    .max(400),
});

const extremeEntry = z
  .object({ id: z.string(), value: z.number() })
  .nullable();

const extremesResponse = z.object({
  ok: z.boolean(),
  // True when the bulk forecast call failed on Open-Meteo's daily
  // quota (HTTP 429) rather than a network fault.
  quotaExceeded: z.boolean(),
  count: z.number(),
  fetchedAt: z.string(),
  hottest: extremeEntry,
  coldest: extremeEntry,
  windiest: extremeEntry,
  rainiest: extremeEntry,
  worstAir: extremeEntry,
  bestAir: extremeEntry,
});

// ── v3.0 layers: NOAA aurora, CelesTrak stations, live flights ──────
//
// Aurora: NOAA SWPC's OVATION model JSON (keyless) — a 1°×1° global
// grid of aurora visibility probability for the forecast time. Tested
// live 2026-11-17 from this network: HTTP 200, 65,160 grid points,
// Observation/Forecast timestamps present. The grid is downsampled
// server-side (only points with probability ≥ a threshold chosen to
// keep the payload ≤ ~16k points) and shipped as a flat
// [lng, lat, prob, …] array; the client renders the field from it
// and reads any city's probability from the nearest grid point.
//
// Stations: CelesTrak's stations TLE file (keyless) carries both the
// ISS (NORAD 25544) and the Chinese station's TIANHE core module
// (NORAD 48274) — wheretheiss.at was tested too: it serves the ISS
// but returns 404 for 48274, so both stations are propagated from
// fresh TLEs with real SGP4 (satellite.js, server-side only — the
// client bundle never sees it). Positions, ±50 min ground tracks and
// Changsha pass predictions (scan 72h at 30s steps; a pass is
// "visible" when its peak finds Changsha in darkness — solar
// altitude < −3° — and the station sunlit under a cylindrical Earth
// shadow) are all computed here; the client only draws them.
//
// Flights: OpenSky Network's states API is the requested primary
// source, but from this server's network it completes the TLS
// handshake and then returns an EMPTY reply (reproduced repeatedly
// 2026-11-17, curl + fetch alike — the service drops this network).
// The action therefore tries OpenSky first on every fresh fetch and
// falls back to the community ADS-B aggregator adsb.lol (keyless,
// tested live: real flights with callsign/type/altitude/speed around
// Beijing/Shanghai/Hong Kong hubs), sweeping 28 hub circles of
// 250 NM (edit #40 added ten inland-China hubs — Chengdu, Chongqing,
// Wuhan, Xi'an, Kunming, Shenyang, Urumqi, Changsha, Lanzhou, Harbin —
// after the old 3-circle China coverage left the whole interior
// unswept) and deduping by transponder hex. Over-cap results are
// thinned by a stratified sampler that guarantees helicopters /
// props / business jets a floor share instead of cutting every kind
// proportionally. The response names the
// source that actually served, and the UI labels it — no silent
// substitution. Results are cached in module memory for 45s so
// client polling never hammers either upstream.

async function fetchFastText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "EarthOnline-GlobalWeather/3.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface OvationFeed {
  "Observation Time"?: string;
  "Forecast Time"?: string;
  coordinates?: Array<[number, number, number]>;
}

const auroraResponse = z.object({
  ok: z.boolean(),
  observationTime: z.string().nullable(),
  forecastTime: z.string().nullable(),
  maxProb: z.number(),
  // Flat [lng, lat, probability] triples, lng in −180…180.
  points: z.array(z.number()).max(60000),
  fetchedAt: z.string(),
});

// ── SGP4 station machinery ──────────────────────────────────────────

interface PvOut {
  position?: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
}

function propagateAt(rec: satellite.SatRec, d: Date): PvOut | null {
  try {
    const pv = satellite.propagate(rec, d) as unknown as PvOut | false;
    if (!pv || typeof pv !== "object" || !pv.position) return null;
    if (typeof pv.position.x !== "number") return null;
    return pv;
  } catch {
    return null;
  }
}

function geoOf(pv: PvOut, d: Date): { lat: number; lng: number; altKm: number } | null {
  if (!pv.position) return null;
  try {
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
    return {
      lat: (g.latitude * 180) / Math.PI,
      lng: (g.longitude * 180) / Math.PI,
      altKm: g.height,
    };
  } catch {
    return null;
  }
}

// Solar coordinates (same NOAA approximation as client/src/solar.ts):
// declination + right ascension + GMST, all degrees.
function sunCoordsServer(date: Date): { decDeg: number; raDeg: number; gmstDeg: number } {
  const RAD = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLong = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const meanAnom = (((357.528 + 0.9856003 * n) % 360) + 360) % 360;
  const g = meanAnom * RAD;
  const eclLong = (meanLong + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const raDeg = Math.atan2(Math.cos(eps) * Math.sin(eclLong), Math.cos(eclLong)) / RAD;
  const decDeg = Math.asin(Math.sin(eps) * Math.sin(eclLong)) / RAD;
  const gmstDeg = (((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360) + 360) % 360;
  return { decDeg, raDeg, gmstDeg };
}

function norm180Server(deg: number): number {
  let d = (((deg + 180) % 360) + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function solarAltServer(lat: number, lng: number, date: Date): number {
  const RAD = Math.PI / 180;
  const { decDeg, raDeg, gmstDeg } = sunCoordsServer(date);
  const ha = norm180Server(gmstDeg + lng - raDeg) * RAD;
  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(decDeg * RAD) +
    Math.cos(lat * RAD) * Math.cos(decDeg * RAD) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

// Cylindrical-shadow sunlit test in ECI coordinates.
function stationSunlit(pv: PvOut, date: Date): boolean {
  if (!pv.position) return false;
  const RAD = Math.PI / 180;
  const { decDeg, raDeg } = sunCoordsServer(date);
  const dec = decDeg * RAD;
  const ra = raDeg * RAD;
  const sx = Math.cos(dec) * Math.cos(ra);
  const sy = Math.cos(dec) * Math.sin(ra);
  const sz = Math.sin(dec);
  const { x, y, z } = pv.position;
  const along = x * sx + y * sy + z * sz;
  if (along >= 0) return true;
  const px = x - along * sx;
  const py = y - along * sy;
  const pz = z - along * sz;
  return Math.sqrt(px * px + py * py + pz * pz) > 6371;
}

const stationSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  altKm: z.number(),
  velocityKmh: z.number(),
  track: z.array(z.tuple([z.number(), z.number()])).max(80),
});

const passSchema = z.object({
  stationId: z.string(),
  start: z.string(),
  peak: z.string(),
  end: z.string(),
  maxEl: z.number(),
  peakAz: z.number(),
  riseAz: z.number(),
  setAz: z.number(),
  visible: z.boolean(),
});

const stationsResponse = z.object({
  ok: z.boolean(),
  fetchedAt: z.string(),
  // Which TLE source actually served: CelesTrak primary, AMSAT
  // mirror fallback; null when neither answered.
  source: z.enum(["celestrak", "amsat"]).nullable(),
  stations: z.array(stationSchema).max(4),
  passes: z.array(passSchema).max(12),
});

// TLE cache (module memory): station TLEs update a few times a day;
// a 6h cache keeps this action from re-downloading the whole file on
// every 30s client poll. Source chain: CelesTrak primary; when it is
// unreachable from the server network (its connections are reset
// ~15s in from here, the same failure class as OpenSky), the AMSAT
// mirror file (nasabare.txt — same 3-line TLE format, carries both
// 25544 and 48274, refreshed daily) serves instead, and the response
// names the source that answered. A stale cache entry beats none.
let tleCache: {
  at: number;
  text: string;
  source: "celestrak" | "amsat";
} | null = null;

async function loadStationsTle(): Promise<{
  text: string;
  source: "celestrak" | "amsat";
} | null> {
  if (tleCache && Date.now() - tleCache.at < 6 * 3600 * 1000) {
    return { text: tleCache.text, source: tleCache.source };
  }
  const primary = await fetchFastText(
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE",
    10000,
  );
  if (primary) {
    tleCache = { at: Date.now(), text: primary, source: "celestrak" };
    return { text: primary, source: "celestrak" };
  }
  const mirror = await fetchFastText(
    "https://www.amsat.org/tle/current/nasabare.txt",
    10000,
  );
  if (mirror) {
    tleCache = { at: Date.now(), text: mirror, source: "amsat" };
    return { text: mirror, source: "amsat" };
  }
  return tleCache
    ? { text: tleCache.text, source: tleCache.source }
    : null;
}

function findTle(text: string, norad: string): [string, string] | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (
      l1 &&
      l2 &&
      l1.startsWith("1 ") &&
      l2.startsWith("2 ") &&
      l1.slice(2, 7).trim() === norad
    ) {
      return [l1.trim(), l2.trim()];
    }
  }
  return null;
}

// ── Flights ─────────────────────────────────────────────────────────

interface FlightOut {
  id: string;
  callsign: string | null;
  lat: number;
  lng: number;
  altM: number | null;
  speedKmh: number | null;
  heading: number | null;
  // Vertical rate in m/s (positive = climbing), from the feed's
  // barometric rate (adsb.lol, ft/min converted) or OpenSky's
  // vertical_rate state field — a live value the card's second row
  // shows as 爬升率； null when the feed omits it.
  vrateMs: number | null;
  detail: string;
  // Icon class for the globe, classified server-side from the ICAO
  // type designator first and the ADS-B emitter category second
  // (edit #38 — the user split the old single "light" bucket into
  // business jets and propeller aircraft): airliners get the
  // paper-plane glyph, business jets a sleek swept-wing jet,
  // propeller aircraft a prop-plane, rotorcraft a helicopter.
  kind: "airliner" | "bizjet" | "prop" | "heli";
  // Registration (tail number) and ICAO type designator, when the
  // feed carries them (adsb.lol does; OpenSky state vectors don't).
  // The flight card's photo lookup keys off these two.
  reg: string | null;
  type: string | null;
}

// Rotorcraft ICAO type designators (the `t` field of ADS-B feeds).
// The ADS-B emitter category A7 is the primary rotorcraft signal;
// this set catches feeds that omit the category. Deliberately
// excludes lookalikes that are actually jets (MD90 is an airliner;
// the MD Helicopters codes are MD52/MD60/EXPL).
const HELI_TYPES = new Set([
  "A109", "A119", "A139", "A149", "A169", "A189",
  "AS32", "AS35", "AS50", "AS55", "AS65",
  "B06", "B06L", "B06T", "B47", "B47G", "B407", "B412", "B427", "B429", "B430", "B505",
  "EC20", "EC25", "EC30", "EC35", "EC45", "EC55", "EC75",
  "EH10", "EXPL", "G2CA",
  "H46", "H47", "H53", "H60", "H64", "H269", "H500",
  "LYNX", "MD52", "MD60",
  "R22", "R44", "R66",
  "S55", "S58", "S61", "S64", "S70", "S76", "S92",
  "UH1", "UH1Y", "V22",
]);

// Business-jet ICAO type designators (edit #38): Gulfstream /
// Global / Challenger / Citation / Falcon / Learjet / Hawker /
// Phenom / Legacy families and the very-light jets. The type
// designator is the primary classification signal — most bizjets
// transmit emitter category A2/A3, which alone cannot separate
// them from airliners.
const BIZJET_TYPES = new Set([
  "GALX", "G150", "G200", "G280",
  "GA4C", "GA5C", "GA6C", "GA7C",
  "GLEX", "GL5T", "GL7T",
  "GLF2", "GLF3", "GLF4", "GLF5", "GLF6",
  "CL30", "CL35", "CL60",
  "C500", "C501", "C510", "C525",
  "C25A", "C25B", "C25C",
  "C550", "C551", "C560", "C56X", "C650",
  "C680", "C68A", "C700", "C750",
  "F900", "F2TH", "F7X", "F8X",
  "E35L", "E50P", "E55P", "E545", "E550",
  "LJ23", "LJ24", "LJ25", "LJ28", "LJ29", "LJ31", "LJ35", "LJ36",
  "LJ40", "LJ45", "LJ55", "LJ60", "LJ70", "LJ75",
  "H25A", "H25B", "H25C", "HA4T",
  "BE40", "MU30", "PRM1",
  "EA50", "SF50", "HDJT", "PC24",
  // Feed-style Dassault codes (adsb.lol's database writes FA7X
  // where ICAO writes F7X — both spellings are in the set) and
  // the Citation M2, a light jet the A1 fallback would otherwise
  // call a prop.
  "FA7X", "FA8X", "FA50", "FA20", "FA10", "C25M", "GL6T",
]);

// Piston / turboprop ICAO type designators (edit #38): the Cessna /
// Piper / Beech singles and twins, Cirrus and Diamond pistons,
// King Airs, PC-12, TBM, Caravan, and the turboprop regionals the
// user named (ATR AT4/AT7 families, Dash 8). Unlisted light types
// still land here via the A1 category fallback in flightKind.
const PROP_TYPES = new Set([
  "C150", "C152", "C170", "C172", "C175", "C177", "C180", "C182",
  "C185", "C206", "C207", "C208", "C210",
  "C310", "C337", "C340", "C402", "C404", "C414", "C421", "C425", "C441",
  "PA18", "PA22", "PA24", "PA28", "PA30", "PA31", "PA32", "PA34",
  "PA38", "PA42", "PA44", "PA46", "P46T", "AEST",
  "PAY1", "PAY2", "PAY3", "PAY4",
  "BE10", "BE17", "BE18", "BE19", "BE23", "BE24", "BE33", "BE35",
  "BE36", "BE55", "BE58", "BE60", "BE65", "BE76", "BE80", "BE88",
  "BE95", "BE99", "BE9L", "BE9T", "BE20", "BE30", "B350", "B190",
  "SR20", "SR22",
  "DV20", "DA40", "DA42", "DA62",
  "M20P", "M20T", "MU2",
  "PC6", "PC12", "TBM7", "TBM8", "TBM9",
  "AT43", "AT45", "AT72", "AT75", "AT76",
  "DH8A", "DH8B", "DH8C", "DH8D",
  "DHC2", "DHC3", "DHC6", "DHC7",
  "SF34", "SB20", "E120", "JS31", "JS32", "JS41",
  "L410", "D228", "F50", "SW3", "SW4",
  "AN2", "AN24", "AN26", "AN28", "AN30", "AN32",
  "GA8", "KODI", "BN2P", "AA5",
]);

// Known jet-airliner type designators (edit #38): checked BEFORE
// the category fallback, so a recognised airliner type can never
// be reclassed by a bogus or bizjet-band emitter category (a live
// B738 transmitting category A1 was observed in the feed and fell
// through to "prop" without this guard). Includes the regional
// jets (ERJ / CRJ / E-Jet families), whose A2 category would
// otherwise read as business jets.
const AIRLINER_TYPES = new Set([
  "A306", "A310", "A318", "A319", "A320", "A321",
  "A20N", "A21N", "A19N",
  "A332", "A333", "A338", "A339", "A343", "A346",
  "A359", "A35K", "A388", "A3ST",
  "B703", "B712", "B720", "B721", "B722",
  "B731", "B732", "B733", "B734", "B735", "B736", "B737", "B738", "B739",
  "B38M", "B39M",
  "B741", "B742", "B743", "B744", "B748",
  "B752", "B753", "B762", "B763", "B764",
  "B772", "B773", "B77L", "B77W", "B788", "B789", "B78X",
  "MD81", "MD82", "MD83", "MD87", "MD88", "MD90", "MD11", "DC10", "L101",
  "E135", "E145", "E45X", "E170", "E175", "E190", "E195", "E290", "E295",
  "CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX", "J328",
  "BCS1", "BCS3", "SU95", "AJ27", "C919", "F70", "F100",
]);

function flightKind(
  category: string | undefined,
  type: string | undefined,
): FlightOut["kind"] {
  if (category === "A7") return "heli";
  const t = type ? type.toUpperCase() : undefined;
  if (t && HELI_TYPES.has(t)) return "heli";
  // Type designator first (edit #38, the user's rule): a known
  // business-jet type is a business jet even when its emitter
  // category is A1 (Mustang / Phenom 100 class) or A3 (G650 /
  // Global class); a known piston/turboprop type is a prop even
  // in A2 (King Air / ATR class); a known airliner type is an
  // airliner whatever category the transponder claims.
  if (t && BIZJET_TYPES.has(t)) return "bizjet";
  if (t && PROP_TYPES.has(t)) return "prop";
  if (t && AIRLINER_TYPES.has(t)) return "airliner";
  // Category fallback for types the sets don't list (the user's
  // rule, scoped so heavy categories stay airliners): A1 (< 15,500
  // lb — overwhelmingly piston singles) → prop; A2 (15,500–75,000
  // lb with no recognised airliner type — the bizjet weight band)
  // → bizjet; A3+ unlisted types are airliners by default.
  if (category === "A1") return "prop";
  if (category === "A2") return "bizjet";
  return "airliner";
}

const flightSchema = z.object({
  id: z.string(),
  callsign: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  altM: z.number().nullable(),
  speedKmh: z.number().nullable(),
  heading: z.number().nullable(),
  vrateMs: z.number().nullable(),
  detail: z.string(),
  kind: z.enum(["airliner", "bizjet", "prop", "heli"]),
  reg: z.string().nullable(),
  type: z.string().nullable(),
});

const flightsResponse = z.object({
  ok: z.boolean(),
  source: z.enum(["opensky", "adsb.lol"]).nullable(),
  count: z.number(),
  fetchedAt: z.string(),
  flights: z.array(flightSchema).max(2000),
});

interface OpenSkyStates {
  states?: Array<Array<unknown>> | null;
}

interface AdsbAc {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  // Vertical rates in ft/min (readsb fields of the adsb.lol feed).
  baro_rate?: number;
  geom_rate?: number;
}
interface AdsbResp {
  ac?: AdsbAc[];
}

// Hub circles swept on the adsb.lol fallback (250 NM ≈ 463 km each).
// Edit #40: the original 18 circles gave mainland China only Beijing /
// Shanghai / Guangzhou, so everything inland of the coast — Changsha,
// Wuhan, Xi'an, Chengdu/Chongqing, Kunming, Shenyang, Harbin, Lanzhou,
// Urumqi — was never even queried and the layer showed literally zero
// aircraft there (the user's screenshot: planes only along the east
// coast and over SE Asia, exactly the old circles' footprint). Ten
// inland China hubs added (28 circles total); adsb.lol's receiver
// coverage over the interior is still thin, so inland density will
// stay below the coast — but the airspace is now actually swept.
// Edit #48: the user's next recording showed the mainland STILL sparse
// while the US was carpeted. Two causes, measured live before this
// change (2026-11-18 ~21:55 CST, replicating this exact sweep): the
// central-China corridors between the #40 circles (Zhengzhou /
// Nanjing / Hangzhou / Hefei / Nanchang / Taiyuan / Hohhot / Guiyang /
// Nanning / Haikou) were only touched at circle edges, and — the
// bigger factor — the 1500 cap's even thinning cut China's ~250 raw
// returns to ~95 while dense US/EU airspace filled the seats. Ten
// more China hubs (38 circles total, 23 over China) plus a regional
// floor in sampleCap below: the same measurement with both changes
// kept all 266 China-bbox aircraft the sweep returned.
const ADSB_HUBS: Array<[number, number]> = [
  [40.0, 116.5], [31.0, 121.8], [23.1, 113.4], [35.5, 139.0],
  [37.5, 127.0], [51.5, 0.0], [49.0, 8.7], [40.4, -3.7],
  [55.9, 37.4], [25.2, 55.3], [28.6, 77.1], [13.0, 100.5],
  [1.3, 104.0], [-33.9, 151.2], [40.7, -74.0], [34.0, -118.2],
  [41.9, -87.6], [30.0, -95.5],
  // Inland China (edit #40): Chengdu, Chongqing, Wuhan, Xi'an,
  // Kunming, Shenyang, Urumqi, Changsha, Lanzhou, Harbin.
  [30.6, 104.1], [29.6, 106.5], [30.6, 114.3], [34.3, 108.9],
  [25.0, 102.7], [41.8, 123.4], [43.8, 87.6], [28.2, 112.9],
  [36.1, 103.8], [45.8, 126.5],
  // Central / northern / southern China infill (edit #48):
  // Zhengzhou, Nanjing, Hangzhou, Hefei, Nanchang, Taiyuan,
  // Hohhot, Guiyang, Nanning, Haikou.
  [34.8, 113.6], [32.0, 118.8], [30.3, 120.2], [31.8, 117.2],
  [28.7, 115.9], [37.7, 112.6], [40.9, 111.7], [26.7, 106.6],
  [22.8, 108.3], [19.9, 110.5],
];

// ── Flight photos (detail-card background) ──────────────────────────
//
// Resolved lazily for the ONE aircraft whose card the user opened —
// never pre-fetched for the ~1500 flights on the globe. Chain
// (edit #38 — the user found the old Planespotters 498×280 backdrop
// soft and asked for this airframe's own, newest, sharpest photo):
//   1. airport-data.com full-size photo via the adsbdb aircraft
//      record's url_photo — this exact airframe at ~1400px wide
//      (verified live 2026-11-18: D-AIZZ → 1400×934 JPEG). adsbdb
//      carries no photographer credit for it, so credit stays null.
//   2. Planespotters public API by registration — this exact
//      airframe; the API returns a single photo, its latest
//      (verified live: exactly one result for every probed reg),
//      with photographer credit — but only at 498×280.
//   3. Planespotters public API by transponder hex — same airframe
//      (covers cards where the registration is unknown, e.g. OpenSky).
//   4. Wikimedia Commons search by aircraft type — a same-type
//      photo at ≥1000px wide, labeled as such on the card
//      (match: "type").
// Planespotters' API requires a User-Agent carrying a contact URL —
// without one it answers an error payload instead of photos (verified
// live 2026-11-18: reg and hex endpoints both return thumbnail_large
// ~500×280 + photographer + photo page link with the compliant UA).
// Its CDN serves no larger rendition than thumbnail_large under any
// probed URL variant (all guesses answered 502) and the photo pages
// themselves are bot-walled (403) from the server network — that is
// why the airport-data full-size step now leads the chain.
// Bytes are downloaded into blob storage exactly like city photos;
// every failure in the chain degrades silently to "no photo" and the
// card keeps its plain face — nothing throws, nothing is invented.

const PLANESPOTTERS_UA =
  "EarthOnline-GlobalWeather/1.0 (+https://www.planespotters.net/photo/api)";

interface PlanespottersResp {
  photos?: Array<{
    thumbnail_large?: { src?: string };
    thumbnail?: { src?: string };
    link?: string;
    photographer?: string;
  }>;
}

interface FoundFlightPhoto {
  sourceUrl: string;
  pageUrl: string | null;
  credit: string | null;
  match: "aircraft" | "type";
}

interface AdsbdbPhotoResp {
  response?: { aircraft?: { url_photo?: string | null } } | string;
}

// Step 1 of the photo chain: adsbdb's aircraft record links a
// full-size photo of this exact airframe on airport-data.com
// (~1400px wide where present — several times the pixels of the
// Planespotters thumbnail). Coverage is partial (many records have
// url_photo: null), which is what the rest of the chain is for.
async function lookupAirportDataPhoto(
  hex: string,
): Promise<FoundFlightPhoto | null> {
  try {
    const res = await fetch(
      `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`,
      {
        headers: { "user-agent": PLANESPOTTERS_UA },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as AdsbdbPhotoResp;
    if (!data.response || typeof data.response === "string") return null;
    const src = data.response.aircraft?.url_photo;
    if (typeof src !== "string" || !src.includes("airport-data.com")) {
      return null;
    }
    return { sourceUrl: src, pageUrl: null, credit: null, match: "aircraft" };
  } catch {
    return null;
  }
}

async function lookupPlanespotters(
  by: "reg" | "hex",
  key: string,
): Promise<FoundFlightPhoto | null> {
  try {
    const res = await fetch(
      `https://api.planespotters.net/pub/photos/${by}/${encodeURIComponent(key)}`,
      {
        headers: { "user-agent": PLANESPOTTERS_UA },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as PlanespottersResp;
    const p = data.photos?.[0];
    const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
    if (!p || !src) return null;
    return {
      sourceUrl: src,
      pageUrl: p.link ?? null,
      credit: p.photographer ?? null,
      match: "aircraft",
    };
  } catch {
    return null;
  }
}

// ICAO type designator → Commons search phrase for the common types
// (the bare designator barely matches anything in Commons' index).
// Unmapped designators fall back to searching the designator itself.
const TYPE_SEARCH: Record<string, string> = {
  A319: "Airbus A319", A320: "Airbus A320", A321: "Airbus A321",
  A20N: "Airbus A320neo", A21N: "Airbus A321neo",
  A332: "Airbus A330-200", A333: "Airbus A330-300",
  A338: "Airbus A330-800neo", A339: "Airbus A330-900neo",
  A359: "Airbus A350-900", A35K: "Airbus A350-1000", A388: "Airbus A380",
  A306: "Airbus A300", A310: "Airbus A310", A343: "Airbus A340-300",
  A346: "Airbus A340-600",
  B712: "Boeing 717", B737: "Boeing 737-700", B738: "Boeing 737-800",
  B739: "Boeing 737-900", B38M: "Boeing 737 MAX 8", B39M: "Boeing 737 MAX 9",
  B744: "Boeing 747-400", B748: "Boeing 747-8",
  B752: "Boeing 757-200", B763: "Boeing 767-300", B764: "Boeing 767-400",
  B772: "Boeing 777-200", B773: "Boeing 777-300", B77W: "Boeing 777-300ER",
  B77L: "Boeing 777-200LR",
  B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10",
  E170: "Embraer E170", E175: "Embraer E175", E190: "Embraer E190",
  E195: "Embraer E195", E290: "Embraer E190-E2",
  CRJ7: "Bombardier CRJ700", CRJ9: "Bombardier CRJ900",
  CRJX: "Bombardier CRJ1000",
  DH8D: "de Havilland Canada Dash 8 Q400",
  AT43: "ATR 42", AT45: "ATR 42", AT75: "ATR 72", AT76: "ATR 72",
  BCS1: "Airbus A220-100", BCS3: "Airbus A220-300",
  C172: "Cessna 172", C152: "Cessna 152", C182: "Cessna 182",
  C150: "Cessna 150", C208: "Cessna 208 Caravan", C441: "Cessna 441",
  C56X: "Cessna Citation Excel", C680: "Cessna Citation Sovereign",
  PA28: "Piper PA-28", PA32: "Piper PA-32", PA34: "Piper PA-34",
  SR20: "Cirrus SR20", SR22: "Cirrus SR22",
  BE20: "Beechcraft Super King Air", BE36: "Beechcraft Bonanza",
  B350: "Beechcraft King Air 350",
  PC12: "Pilatus PC-12", PC24: "Pilatus PC-24",
  DA40: "Diamond DA40", DA42: "Diamond DA42", DA62: "Diamond DA62",
  R44: "Robinson R44", R66: "Robinson R66", R22: "Robinson R22",
  B407: "Bell 407", B412: "Bell 412", B429: "Bell 429", B06: "Bell 206",
  EC35: "Airbus Helicopters H135", EC45: "Airbus Helicopters H145",
  EC30: "Airbus Helicopters H125", AS50: "Airbus Helicopters H125",
  A139: "Leonardo AW139", A169: "Leonardo AW169", A189: "Leonardo AW189",
  H60: "Sikorsky UH-60 Black Hawk", S76: "Sikorsky S-76", S92: "Sikorsky S-92",
  GLF5: "Gulfstream G550", GLEX: "Bombardier Global Express",
  CL30: "Bombardier Challenger 300", F2TH: "Dassault Falcon 2000",
  LJ45: "Learjet 45", H25B: "Hawker 800",
};

interface CommonsSearch {
  query?: {
    pages?: Array<{
      index?: number;
      imageinfo?: Array<{
        thumburl?: string;
        url?: string;
        width?: number;
        mime?: string;
        descriptionurl?: string;
        extmetadata?: { Artist?: { value?: string } };
      }>;
    }>;
  };
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function lookupCommonsTypePhoto(
  type: string,
): Promise<FoundFlightPhoto | null> {
  const phrase = TYPE_SEARCH[type] ?? type;
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2" +
    "&generator=search&gsrnamespace=6&gsrlimit=8" +
    `&gsrsearch=${encodeURIComponent(`${phrase} aircraft`)}` +
    "&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600";
  const data = await fetchFastJson<CommonsSearch>(url, 9000);
  const pages = [...(data?.query?.pages ?? [])].sort(
    (a, b) => (a.index ?? 99) - (b.index ?? 99),
  );
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || info.mime !== "image/jpeg") continue;
    if ((info.width ?? 0) < 1000) continue;
    const src = info.thumburl ?? info.url;
    if (!src) continue;
    const artist = info.extmetadata?.Artist?.value
      ? stripHtmlTags(info.extmetadata.Artist.value)
      : "";
    return {
      // Same rule as city photos: strip the tracking query the API
      // appends, the bare thumb URL is the sanctioned form.
      sourceUrl: src.split("?")[0] ?? src,
      pageUrl: info.descriptionurl ?? null,
      credit: artist.length > 0 ? artist : null,
      match: "type",
    };
  }
  return null;
}

const flightPhotoResponse = z.object({
  url: z.string().nullable(),
  pageUrl: z.string().nullable(),
  credit: z.string().nullable(),
  match: z.enum(["aircraft", "type"]).nullable(),
  // Which source the photo came from, for the card's attribution
  // line (derived from the stored source URL — see getFlightPhoto).
  source: z.enum(["airport-data", "planespotters", "commons"]).nullable(),
});

// Negative flight-photo rows are retried after this long (a plane with
// no photo today may be photographed tomorrow); 'ok' rows are kept
// until the airframe's photo is superseded by a re-resolve.
const FLIGHT_PHOTO_NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One-time chain upgrade (edit #38): 'ok' rows resolved before this
// epoch (2026-11-18 00:00 Asia/Shanghai) hold the old chain's best —
// usually the 498×280 Planespotters thumbnail. getFlightPhoto
// re-resolves such a row once under the new airport-data-first
// chain; the re-resolve stamps a fresh updatedAt, so it never loops.
const FLIGHT_PHOTO_HD_EPOCH_MS = 1794931200000;

async function resolveFlightPhoto(
  ctx: Ctx,
  hex: string,
  reg: string | null,
  type: string | null,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  let found: FoundFlightPhoto | null = null;
  found = await lookupAirportDataPhoto(hex);
  if (!found && reg) found = await lookupPlanespotters("reg", reg.toUpperCase());
  if (!found) found = await lookupPlanespotters("hex", hex);
  if (!found && type) found = await lookupCommonsTypePhoto(type);
  const now = Date.now();
  if (!found) {
    await db
      .insert(schema.flightPhotos)
      .values({
        hex,
        sourceUrl: null,
        pageUrl: null,
        blobKey: null,
        credit: null,
        match: null,
        status: "none",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.flightPhotos.hex,
        set: {
          sourceUrl: null,
          pageUrl: null,
          blobKey: null,
          credit: null,
          match: null,
          status: "none",
          updatedAt: now,
        },
      });
    return;
  }
  let blobKey: string | null = null;
  const dl = await downloadImage(found.sourceUrl);
  if (dl) {
    blobKey = `flight-photos/${hex.replace(/[^a-z0-9-]+/gi, "_")}`;
    await ctx.blobs.put(blobKey, dl.bytes, { contentType: dl.contentType });
  }
  // Download failed (transient): the row still records the source URL
  // so getFlightPhoto can hand it out as a last-resort live link.
  await db
    .insert(schema.flightPhotos)
    .values({
      hex,
      sourceUrl: found.sourceUrl,
      pageUrl: found.pageUrl,
      blobKey,
      credit: found.credit,
      match: found.match,
      status: "ok",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.flightPhotos.hex,
      set: {
        sourceUrl: found.sourceUrl,
        pageUrl: found.pageUrl,
        blobKey,
        credit: found.credit,
        match: found.match,
        status: "ok",
        updatedAt: now,
      },
    });
}

// ── Flight routes (detail-card 始发地 / 目的地) ─────────────────────
//
// ADS-B broadcasts position, never the route. The tapped flight's
// callsign is reverse-looked-up in adsbdb's public route database
// (https://api.adsbdb.com/v0/callsign/<CALLSIGN> — the www host serves
// the SPA, only the api subdomain answers JSON; verified live
// 2026-11-18). Measured hit rate before building this: 34 of 40 real
// airline callsigns sampled from the live adsb.lol feed resolved to a
// route (85%); misses answer {"response":"unknown callsign"}. Lookups
// happen ONLY for the one aircraft whose card is open and are cached
// per callsign in flight_routes — never pre-fetched for the layer.
// A miss is cached as 'none' and the card shows 未知: routes are never
// invented. 'ok' rows re-validate after 30 days (flight numbers are
// re-routed seasonally), 'none' rows after 7 days.

const FLIGHT_ROUTE_OK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLIGHT_ROUTE_NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface AdsbdbAirport {
  municipality?: string;
  name?: string;
  iata_code?: string;
}
interface AdsbdbResp {
  response?: {
    flightroute?: {
      origin?: AdsbdbAirport;
      destination?: AdsbdbAirport;
    };
  } | string;
}

interface RouteAirport {
  city: string | null;
  name: string | null;
  iata: string | null;
}

function adsbdbAirport(a: AdsbdbAirport | undefined): RouteAirport | null {
  if (!a || (!a.name && !a.municipality && !a.iata_code)) return null;
  return {
    city: a.municipality ?? null,
    name: a.name ?? null,
    iata: a.iata_code ?? null,
  };
}

async function lookupAdsbdbRoute(
  callsign: string,
): Promise<{ origin: RouteAirport; destination: RouteAirport } | null> {
  try {
    const res = await fetch(
      `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
      {
        headers: { "user-agent": PLANESPOTTERS_UA },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as AdsbdbResp;
    if (!data.response || typeof data.response === "string") return null;
    const origin = adsbdbAirport(data.response.flightroute?.origin);
    const destination = adsbdbAirport(data.response.flightroute?.destination);
    if (!origin || !destination) return null;
    return { origin, destination };
  } catch {
    return null;
  }
}

const airportOutSchema = z.object({
  city: z.string().nullable(),
  name: z.string().nullable(),
  iata: z.string().nullable(),
});
const flightRouteResponse = z.object({
  found: z.boolean(),
  origin: airportOutSchema.nullable(),
  destination: airportOutSchema.nullable(),
});

// ── Flight aircraft archive (detail-card 运营方 / 国籍） ─────────────
//
// adsbdb's public aircraft database (https://api.adsbdb.com/v0/
// aircraft/<HEX> — verified live 2026-11-18: returns the full type
// variant, manufacturer, registration, registered owner/operator and
// registry country for a transponder hex) backs the card's second
// info row after the user asked to replace 始发地/目的地 with other
// real interface data. Lookups happen ONLY for the one aircraft whose
// card is open, cached per hex in flight_aircraft. A miss is cached
// as 'none' and the card shows 未知 — nothing is invented. NOTE: this
// endpoint (like the feed, hexdb, Planespotters and tar1090-db — all
// checked live the same day) carries NO manufacture year or
// first-flight date, so there is deliberately no 机龄 field; the one
// database that has it (OpenSky metadata) is unreachable from the
// server network. 'ok' rows re-validate after 30 days, 'none' rows
// after 7 days.

const FLIGHT_AIRCRAFT_OK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLIGHT_AIRCRAFT_NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface AdsbdbAircraft {
  type?: string;
  manufacturer?: string;
  registration?: string;
  registered_owner?: string;
  registered_owner_country_name?: string;
  registered_owner_country_iso_name?: string;
}
interface AdsbdbAircraftResp {
  response?: { aircraft?: AdsbdbAircraft } | string;
}

interface FoundAircraft {
  typeFull: string | null;
  manufacturer: string | null;
  registration: string | null;
  owner: string | null;
  ownerCountry: string | null;
  ownerCountryIso: string | null;
}

async function lookupAdsbdbAircraft(
  hex: string,
): Promise<FoundAircraft | null> {
  try {
    const res = await fetch(
      `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`,
      {
        headers: { "user-agent": PLANESPOTTERS_UA },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as AdsbdbAircraftResp;
    if (!data.response || typeof data.response === "string") return null;
    const a = data.response.aircraft;
    if (!a || (!a.registration && !a.registered_owner && !a.type)) {
      return null;
    }
    const clean = (v: string | undefined): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
    return {
      typeFull: clean(a.type),
      manufacturer: clean(a.manufacturer),
      registration: clean(a.registration),
      owner: clean(a.registered_owner),
      ownerCountry: clean(a.registered_owner_country_name),
      ownerCountryIso: clean(a.registered_owner_country_iso_name),
    };
  } catch {
    return null;
  }
}

const flightAircraftResponse = z.object({
  found: z.boolean(),
  typeFull: z.string().nullable(),
  manufacturer: z.string().nullable(),
  owner: z.string().nullable(),
  country: z.string().nullable(),
  countryIso: z.string().nullable(),
});

let flightsCache: { at: number; payload: z.infer<typeof flightsResponse> } | null = null;

function strideSample(flights: FlightOut[], n: number): FlightOut[] {
  if (n <= 0) return [];
  if (flights.length <= n) return flights.slice();
  const stride = flights.length / n;
  const out: FlightOut[] = [];
  for (let i = 0; i < n; i++) {
    const f = flights[Math.floor(i * stride)];
    if (f) out.push(f);
  }
  return out;
}

// Stratified cap (edit #40): the old single even-stride sampler cut
// every kind in proportion to its share of the raw feed, so the rare
// classes — helicopters, props, business jets — were thinned to
// near-invisibility by the dense airliner traffic over Europe / North
// America (the user's "直升机、小型飞机好少"). Each rare kind is now
// guaranteed a floor share of the cap (heli 10%, prop 15%, bizjet
// 15%), drawn only up to what that kind actually has in the feed and
// sampled evenly within the kind so its geographic spread survives;
// airliners fill the remaining seats, and any seats still left (a
// feed dominated by rare kinds) top up from the rare kinds' overflow.
// Under the cap nothing is dropped, exactly as before.
const KIND_FLOOR_SHARE: Record<FlightOut["kind"], number> = {
  heli: 0.1,
  prop: 0.15,
  bizjet: 0.15,
  airliner: 0,
};

function stratifiedSample(flights: FlightOut[], cap: number): FlightOut[] {
  if (flights.length <= cap) return flights.slice();
  const byKind = new Map<FlightOut["kind"], FlightOut[]>();
  for (const f of flights) {
    const list = byKind.get(f.kind);
    if (list) list.push(f);
    else byKind.set(f.kind, [f]);
  }
  const out: FlightOut[] = [];
  let remaining = cap;
  for (const kind of ["heli", "prop", "bizjet"] as const) {
    const list = byKind.get(kind) ?? [];
    const take = Math.min(
      list.length,
      Math.floor(cap * KIND_FLOOR_SHARE[kind]),
    );
    out.push(...strideSample(list, take));
    remaining -= take;
  }
  const airliners = byKind.get("airliner") ?? [];
  const airTake = Math.min(airliners.length, remaining);
  out.push(...strideSample(airliners, airTake));
  remaining -= airTake;
  if (remaining > 0) {
    const used = new Set(out.map((f) => f.id));
    for (const kind of ["heli", "prop", "bizjet"] as const) {
      if (remaining <= 0) break;
      const rest = (byKind.get(kind) ?? []).filter((f) => !used.has(f.id));
      const extra = strideSample(rest, Math.min(rest.length, remaining));
      out.push(...extra);
      remaining -= extra.length;
    }
  }
  return out;
}

// Regional balance (edit #48): kind floors alone still let the dense
// US/EU airspace eat the whole 1500 cap — China's raw returns were
// thinned ~2.6× by the even stride while North America kept hundreds
// of near-duplicate-density seats (measured live 2026-11-18 ~21:55
// CST: 251 China-bbox aircraft in the raw sweep, ~95 after the old
// cap). The cap therefore reserves a floor share for the China
// airspace box (mainland bbox lat 18–54, lng 73–135 — the same box
// the before/after measurement used): China flights are stratified-
// sampled into their reserved seats first (kind floors apply inside
// the reservation too), the rest of the world fills the remaining
// seats under the same kind rules, and any seats still left top up
// from whichever pool has leftovers. Under the cap nothing changes.
const CHINA_FLOOR_SHARE = 0.25;

function inChinaAirspace(f: FlightOut): boolean {
  return f.lat >= 18 && f.lat <= 54 && f.lng >= 73 && f.lng <= 135;
}

function sampleCap(flights: FlightOut[], cap: number): FlightOut[] {
  if (flights.length <= cap) return flights;
  const china = flights.filter(inChinaAirspace);
  if (china.length === 0) return stratifiedSample(flights, cap);
  const rest = flights.filter((f) => !inChinaAirspace(f));
  const chinaSeats = Math.min(
    china.length,
    Math.floor(cap * CHINA_FLOOR_SHARE),
  );
  const out = stratifiedSample(china, chinaSeats);
  out.push(...stratifiedSample(rest, cap - out.length));
  if (out.length < cap) {
    const used = new Set(out.map((f) => f.id));
    const leftovers = flights.filter((f) => !used.has(f.id));
    out.push(
      ...strideSample(
        leftovers,
        Math.min(leftovers.length, cap - out.length),
      ),
    );
  }
  return out;
}

// ── Live ships (AIS) ─────────────────────────────────────────────
//
// The ship layer's twin of getFlights. Source chain:
//
// PRIMARY — aisstream.io, the global AIS WebSocket stream, keyed
// with an API key supplied through the AISSTREAM_API_KEY
// environment variable (see .env.example) — it is never sent to
// the client, never put in a URL the page exposes. A module-level collector keeps
// one persistent wss connection subscribed to the world's major
// shipping boxes and folds PositionReport + ShipStaticData messages
// into in-memory maps; getShips serves the fresh (≤60 min) snapshot.
// The sandbox/server egress goes through an HTTP proxy, and Bun's
// WebSocket client ignores the proxy env vars by itself, so the
// collector passes the env proxy explicitly when one is configured.
//
// SECOND — facha.dev, a key-free AIS radius API
// (https://api.facha.dev/v1/ship/radius/<lat>/<lon>/<km>, radius in
// KILOMETRES; response shape documented from a real captured body:
// mmsi / timestamp / latitude / longitude / courseOverGround /
// speedOverGround (knots) / heading / navigationalStatus /
// imoNumber / name / callSign / type (AIS code) / vesselType
// (decoded English) / dimensionToBow|Stern|Port|Starboard (metres)
// / draught (metres) / destination (crew-typed free text) /
// estimatedTimeOfArrival ("MM-DD HH:mm", no year). Rate limit 20
// requests/minute on the live-ship bucket — the sweep below is 16
// hub calls and results are cached 60s server-side. VERIFICATION
// NOTE: at build time (2026-11-18) api.facha.dev answered 502 Bad
// Gateway from both the sandbox and the server runtime network —
// its gateway was up, its backend down. The layer therefore treats
// it exactly like flights treat OpenSky: tried first on every fresh
// fetch, and the fallback below serves (and is labelled) whenever
// facha.dev yields nothing.
//
// FALLBACK — Digitraffic, the Finnish Transport Infrastructure
// Agency's keyless open AIS API (verified live 2026-11-18 from the
// server network), used when both sources above yield nothing:
// GET https://meri.digitraffic.fi/api/ais/v1/
// locations (GeoJSON features: geometry [lng,lat] + properties
// sog (knots) / cog / heading (511 = unavailable) / navStat /
// timestampExternal) merged by MMSI with GET .../ais/v1/vessels
// (name / shipType (AIS code) / imo / callSign / destination /
// draught in DECIMETRES (AIS standard) / eta as the raw AIS
// bit-packed month|day|hour|minute / referencePointA..D =
// dimensionToBow/Stern/Port/Starboard in metres). Coverage is the
// Baltic / Finnish waters only — the response's `source` field
// names whichever source actually served and the UI labels it.
//
// AIS is a near-shore VHF broadcast: open-ocean coverage is sparse
// by physics, exactly like the ADS-B flight layer — positions are
// never invented to fill the sea. ok:false with an empty list when
// both sources yield nothing.

type ShipKind = "cargo" | "tanker" | "passenger" | "fishing" | "other";

function shipKindOf(typeCode: number | null): ShipKind {
  if (typeCode == null) return "other";
  if (typeCode >= 70 && typeCode <= 79) return "cargo";
  if (typeCode >= 80 && typeCode <= 89) return "tanker";
  if (typeCode >= 60 && typeCode <= 69) return "passenger";
  if (typeCode === 30) return "fishing";
  return "other";
}

// Chinese vessel-type label from the AIS ship-type code (the same
// code both sources carry). Falls back to the source's own decoded
// English type string (facha.dev provides one), then to a generic
// 船舶 — a label is never invented beyond the code's own meaning.
function shipTypeLabel(typeCode: number | null, rawType: string | null): string {
  if (typeCode != null) {
    if (typeCode >= 70 && typeCode <= 79) return "货船";
    if (typeCode >= 80 && typeCode <= 89) return "油轮";
    if (typeCode >= 60 && typeCode <= 69) return "客船";
    if (typeCode >= 40 && typeCode <= 49) return "高速船";
    if (typeCode >= 20 && typeCode <= 29) return "翼地效应船";
    switch (typeCode) {
      case 30: return "渔船";
      case 31:
      case 32: return "拖带船";
      case 33: return "工程船";
      case 34: return "潜水作业船";
      case 35: return "军用船";
      case 36: return "帆船";
      case 37: return "游艇";
      case 50: return "引航船";
      case 51: return "搜救船";
      case 52: return "拖船";
      case 53: return "港口供应船";
      case 54: return "防污船";
      case 55: return "执法船";
      case 58: return "医疗船";
      default: break;
    }
  }
  return rawType && rawType.trim().length > 0 ? rawType.trim() : "船舶";
}

interface ShipOut {
  id: string; // MMSI
  name: string | null;
  lat: number;
  lng: number;
  sogKn: number | null;
  cog: number | null;
  heading: number | null;
  kind: ShipKind;
  typeCode: number | null;
  typeLabel: string;
  imo: number | null;
  callsign: string | null;
  dest: string | null;
  etaText: string | null;
  draughtM: number | null;
  lenM: number | null;
  beamM: number | null;
  navStat: number | null;
  reportedAt: string | null;
}

const shipOutSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  sogKn: z.number().nullable(),
  cog: z.number().nullable(),
  heading: z.number().nullable(),
  kind: z.enum(["cargo", "tanker", "passenger", "fishing", "other"]),
  typeCode: z.number().nullable(),
  typeLabel: z.string(),
  imo: z.number().nullable(),
  callsign: z.string().nullable(),
  dest: z.string().nullable(),
  etaText: z.string().nullable(),
  draughtM: z.number().nullable(),
  lenM: z.number().nullable(),
  beamM: z.number().nullable(),
  navStat: z.number().nullable(),
  reportedAt: z.string().nullable(),
});

const shipsResponse = z.object({
  ok: z.boolean(),
  source: z.enum(["aisstream.io", "facha.dev", "digitraffic"]).nullable(),
  count: z.number(),
  fetchedAt: z.string(),
  ships: z.array(shipOutSchema),
});

// Port / strait hubs for the facha.dev sweep (120 km radius each):
// the Yangtze estuary, Pearl River mouth, Taiwan Strait, Tokyo Bay
// approach, Busan/Tsushima, both Malacca ends, Rotterdam + Dover,
// Hamburg/Elbe mouth, Gibraltar, Suez north approach, the
// Bosphorus, New York, Los Angeles/Long Beach, Panama Atlantic.
const SHIP_HUBS: Array<[number, number]> = [
  [31.1, 121.7],
  [22.3, 114.3],
  [24.7, 119.0],
  [35.4, 139.9],
  [35.0, 129.3],
  [1.26, 103.9],
  [5.7, 97.8],
  [51.95, 3.9],
  [50.9, 1.3],
  [53.9, 8.0],
  [36.05, -5.45],
  [31.35, 32.25],
  [41.2, 29.15],
  [40.45, -73.9],
  [33.72, -118.3],
  [9.35, -79.9],
];

interface FachaShip {
  mmsi?: number;
  timestamp?: string;
  longitude?: number;
  latitude?: number;
  courseOverGround?: number | null;
  speedOverGround?: number | null;
  heading?: number | null;
  navigationalStatus?: number;
  imoNumber?: number;
  name?: string;
  callSign?: string;
  type?: number;
  vesselType?: string;
  dimensionToBow?: number;
  dimensionToStern?: number;
  dimensionToPort?: number;
  dimensionToStarboard?: number;
  draught?: number;
  destination?: string;
  estimatedTimeOfArrival?: string;
}

const cleanShipText = (v: string | undefined): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

// AIS course/heading guards: COG 360 and heading 511 are the
// standard "not available" sentinels. SOG is likewise sentinel-coded:
// 102.2 kn is the AIS encoding's "102.2 or more / not available"
// value, and real feeds leak it for moored ships (an anchored tanker
// reporting exactly 102.2 kn was observed live) — the ROUNDED value
// must stay strictly below it, so 102.2 itself never displays as a
// speed.
const shipCourse = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 360
    ? Math.round(v * 10) / 10
    : null;
const shipSpeed = (v: number | null | undefined): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const r = Math.round(v * 10) / 10;
  return r < 102.2 ? r : null;
};

// Report-sanity gates for the LIVE layer (user report 2026-11-22:
// 「船怎么在陆地了」, screenshot of ship icons sitting deep inland
// in Finland's Karelia). Autopsy against the live Digitraffic feed
// (773 reports, cross-checked point-by-point against Natural Earth
// 10m land/lake polygons): the feed mixes (a) genuine traffic —
// including Lake Saimaa's commercial waterway, whose narrow arms
// cross North/South Karelia and read as "land" at globe zoom but
// ARE water, and those reports stay — with (b) reports that stopped
// being live long ago: 147 of 773 (19%) were over an hour old and
// 82 over 12 hours, and the worst offenders were a cluster of four
// corrupted/spoofed reports pinned at 57.67°N 32.52°E — deep inland
// Russia — claiming 45–81 kn with timestamps 3–9 HOURS old. A live
// layer must not plot a position its own feed stopped confirming
// hours ago (the vessel docked, left coverage, or the reception was
// a one-off corrupt/spoof hit — the inland cluster is the third).
// Gate 1 — freshness: a report is plotted only when its timestamp
// is at most 60 minutes old (10 minutes of future clock skew
// tolerated). AIS Class A/B transponders report at least every
// 3 minutes while powered, so 60 minutes only ever removes
// switched-off / out-of-coverage / corrupt entries. A report with
// no usable timestamp fails the gate on the Digitraffic branch
// (that feed always carries one); on the facha branch an
// unparseable timestamp is kept (its format is only known from a
// captured body, so only a timestamp that PROVES staleness drops).
// Gate 2 — impossible claimed speed: a raw SOG strictly between
// 45 and the 102.2 sentinel marks the whole position report as
// corrupt (fresh spoofed hits in Vyborg Bay claimed 49.2 / 67.1 kn;
// no vessel class in this feed's waters sustains >45 kn — the
// fastest Baltic fast ferries make ~40). Values at or above the
// sentinel are exempt: that is the encoding's out-of-band zone
// (102.2/102.3 = "speed not available"; the feed even leaks a
// 184.0 field-garbage value on a fresh, on-water Swedish-coast
// report) — the speed half is unusable there but says nothing
// about the position, and shipSpeed already refuses to display
// any of those values on the card.
const SHIP_MAX_REPORT_AGE_MS = 60 * 60 * 1000;
const SHIP_MAX_SKEW_MS = 10 * 60 * 1000;
const shipReportFresh = (t: number | null | undefined): boolean =>
  typeof t === "number" &&
  Number.isFinite(t) &&
  Date.now() - t <= SHIP_MAX_REPORT_AGE_MS &&
  t - Date.now() <= SHIP_MAX_SKEW_MS;
const shipClaimedSpeedSane = (v: number | null | undefined): boolean =>
  !(
    typeof v === "number" &&
    Number.isFinite(v) &&
    v > 45 &&
    v < 102.2
  );

// facha.dev ETA ("MM-DD HH:mm", no year — crew-typed) reformatted
// for the card; unparseable values pass through as the raw text.
function fachaEtaText(raw: string | undefined): string | null {
  const t = cleanShipText(raw);
  if (!t) return null;
  const m = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  return `${Number(m[1])}月${Number(m[2])}日 ${m[3]}:${m[4]}`;
}

// Digitraffic's eta is the raw AIS bit-packed value
// (month<<16 | day<<11 | hour<<6 | minute — verified numerically
// against a live record: 756608 = 11月17日 14:00). Hour 24 / minute
// 60 are the AIS "not available" sentinels; anything outside valid
// ranges decodes to null rather than a fabricated date.
function digitrafficEtaText(eta: number | undefined): string | null {
  if (typeof eta !== "number" || !Number.isFinite(eta) || eta <= 0) {
    return null;
  }
  const month = (eta >> 16) & 0xf;
  const day = (eta >> 11) & 0x1f;
  const hour = (eta >> 6) & 0x1f;
  const minute = eta & 0x3f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${month}月${day}日 ${hh}:${mm}`;
}

interface DtLocations {
  features?: Array<{
    mmsi?: number;
    geometry?: { coordinates?: number[] };
    properties?: {
      sog?: number;
      cog?: number;
      heading?: number;
      navStat?: number;
      timestampExternal?: number;
    };
  }>;
}

interface DtVessel {
  mmsi?: number;
  name?: string;
  shipType?: number;
  imo?: number;
  callSign?: string;
  destination?: string;
  draught?: number;
  eta?: number;
  referencePointA?: number;
  referencePointB?: number;
  referencePointC?: number;
  referencePointD?: number;
}

let shipsCache: { at: number; payload: z.infer<typeof shipsResponse> } | null = null;

function strideSampleShips(ships: ShipOut[], n: number): ShipOut[] {
  if (ships.length <= n) return ships;
  const stride = ships.length / n;
  const out: ShipOut[] = [];
  for (let i = 0; i < n; i++) {
    const s = ships[Math.floor(i * stride)];
    if (s) out.push(s);
  }
  return out;
}

// ── aisstream.io collector (primary AIS source) ──────────────────
//
// The aisstream.io API key, from the AISSTREAM_API_KEY environment
// variable (see .env.example). SERVER SIDE ONLY, exactly like the
// Mapillary token above: it is used in the WebSocket subscription
// message from this process and is never returned by any action,
// never embedded in the client bundle.
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY ?? "";
const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

// Subscription boxes ([SW corner], [NE corner], lat/lng degrees):
// the world's major coastal shipping areas. Open-ocean gaps between
// boxes are the AIS system's physical reality (terrestrial receivers
// reach ~40 nm from shore; aisstream's satellite feed is partial) —
// coverage is never filled in.
const AIS_BOXES: Array<[[number, number], [number, number]]> = [
  [[15, 105], [45, 145]], // China seas / Japan / Korea
  [[-12, 90], [22, 112]], // SE Asia / Malacca
  [[3, 60], [25, 92]], // Indian coast / Sri Lanka
  [[10, 42], [32, 62]], // Arabia / Persian Gulf / Red Sea south
  [[29, -7], [48, 42]], // Mediterranean / Black Sea
  [[46, -6], [66, 32]], // NW Europe / North Sea / Baltic
  [[5, -100], [50, -55]], // North America east / Caribbean / Gulf
  [[15, -135], [55, -110]], // North America west
  [[-40, -85], [10, -30]], // South America coasts
  [[-38, -20], [37, 55]], // Africa coasts
  [[-48, 105], [-5, 180]], // Oceania
];

interface AisLivePos {
  lat: number;
  lng: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  navStat: number | null;
  at: number; // epoch ms of the report (MetaData.time_utc)
  name: string | null;
}

interface AisLiveStatic {
  name: string | null;
  imo: number | null;
  callsign: string | null;
  typeCode: number | null;
  dest: string | null;
  etaText: string | null;
  draughtM: number | null;
  lenM: number | null;
  beamM: number | null;
}

interface AisEnvelope {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
    time_utc?: string;
  };
  Message?: {
    PositionReport?: {
      Latitude?: number;
      Longitude?: number;
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      Name?: string;
      ImoNumber?: number;
      CallSign?: string;
      Type?: number;
      Destination?: string;
      Eta?: { Month?: number; Day?: number; Hour?: number; Minute?: number };
      MaximumStaticDraught?: number;
      Dimension?: { A?: number; B?: number; C?: number; D?: number };
    };
  };
}

const aisLivePos = new Map<string, AisLivePos>();
const aisLiveStatic = new Map<string, AisLiveStatic>();
let aisWs: WebSocket | null = null;
let aisLastMsgAt = 0;
let aisRetryAfter = 0;

// aisstream's MetaData.time_utc looks like
// "2026-11-22 12:56:43.802366788 +0000 UTC" — not a shape Date.parse
// accepts everywhere, so the fields are pulled out explicitly.
function aisParseTimeUtc(s: string | undefined): number | null {
  if (typeof s !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isFinite(t) ? t : null;
}

// AIS static ETA fields: hour 24 / minute 60 are the "not available"
// sentinels; anything out of range decodes to null, never a guess.
function aisEtaText(
  eta: { Month?: number; Day?: number; Hour?: number; Minute?: number } | undefined,
): string | null {
  if (!eta) return null;
  const { Month: mo, Day: d, Hour: h, Minute: mi } = eta;
  if (
    typeof mo !== "number" ||
    typeof d !== "number" ||
    typeof h !== "number" ||
    typeof mi !== "number" ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    h > 23 ||
    mi > 59
  ) {
    return null;
  }
  const hh = String(h).padStart(2, "0");
  const mm = String(mi).padStart(2, "0");
  return `${mo}月${d}日 ${hh}:${mm}`;
}

function pruneAisLive(): void {
  for (const [id, p] of aisLivePos) {
    if (!shipReportFresh(p.at)) aisLivePos.delete(id);
  }
}

function handleAisMessage(data: unknown): void {
  if (typeof data !== "string") return;
  let m: AisEnvelope;
  try {
    m = JSON.parse(data) as AisEnvelope;
  } catch {
    return;
  }
  const meta = m.MetaData;
  if (typeof meta?.MMSI !== "number" || !Number.isFinite(meta.MMSI)) return;
  const id = String(meta.MMSI);
  const at = aisParseTimeUtc(meta.time_utc) ?? Date.now();
  const metaName = cleanShipText(meta.ShipName);
  if (m.MessageType === "PositionReport") {
    const p = m.Message?.PositionReport;
    const lat = typeof p?.Latitude === "number" ? p.Latitude : meta.latitude;
    const lng =
      typeof p?.Longitude === "number" ? p.Longitude : meta.longitude;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return;
    }
    // The same two sanity gates as every other source: a stale or
    // impossible-speed report never enters the live map.
    if (!shipReportFresh(at)) return;
    if (!shipClaimedSpeedSane(p?.Sog)) return;
    const prev = aisLivePos.get(id);
    if (prev && prev.at > at) return;
    aisLivePos.set(id, {
      lat,
      lng,
      sog: typeof p?.Sog === "number" ? p.Sog : null,
      cog: typeof p?.Cog === "number" ? p.Cog : null,
      heading: typeof p?.TrueHeading === "number" ? p.TrueHeading : null,
      navStat:
        typeof p?.NavigationalStatus === "number"
          ? p.NavigationalStatus
          : null,
      at,
      name: metaName ?? prev?.name ?? null,
    });
  } else if (m.MessageType === "ShipStaticData") {
    const s = m.Message?.ShipStaticData;
    if (!s) return;
    const len = (s.Dimension?.A ?? 0) + (s.Dimension?.B ?? 0);
    const beam = (s.Dimension?.C ?? 0) + (s.Dimension?.D ?? 0);
    aisLiveStatic.set(id, {
      name: cleanShipText(s.Name) ?? metaName,
      imo:
        typeof s.ImoNumber === "number" && s.ImoNumber > 0
          ? s.ImoNumber
          : null,
      callsign: cleanShipText(s.CallSign),
      typeCode: typeof s.Type === "number" ? s.Type : null,
      dest: cleanShipText(s.Destination),
      etaText: aisEtaText(s.Eta),
      // aisstream decodes MaximumStaticDraught to metres already
      // (verified live: 4 / 3.4 / 1.8 for real vessels).
      draughtM:
        typeof s.MaximumStaticDraught === "number" &&
        s.MaximumStaticDraught > 0
          ? Math.round(s.MaximumStaticDraught * 10) / 10
          : null,
      lenM: len > 0 ? len : null,
      beamM: beam > 0 ? beam : null,
    });
    // A static report's MetaData also carries a position — seed one
    // for a vessel whose position report we have not seen yet (no
    // motion fields; the card shows — for those).
    if (
      !aisLivePos.has(id) &&
      typeof meta.latitude === "number" &&
      typeof meta.longitude === "number" &&
      shipReportFresh(at)
    ) {
      aisLivePos.set(id, {
        lat: meta.latitude,
        lng: meta.longitude,
        sog: null,
        cog: null,
        heading: null,
        navStat: null,
        at,
        name: metaName,
      });
    }
  } else {
    return;
  }
  if (aisLivePos.size > 30000) pruneAisLive();
}

// The egress proxy for the collector socket, resolved once per
// process through the privileged handler (action code may not read
// the host env itself). undefined = not resolved yet; null = no
// proxy configured (connect directly).
let aisProxy: string | null | undefined = undefined;

// Keep exactly one collector socket alive. Started lazily by
// getShips (never at module load — a process that never serves the
// ship layer never opens a stream), reconnected with a 30 s backoff
// after any drop, and force-recycled when it has been silent for
// 3 minutes (the subscribed boxes produce constant traffic, so
// silence means the connection is dead even if no close arrived).
async function ensureAisStream(ctx: Ctx): Promise<void> {
  const now = Date.now();
  if (aisWs) {
    if (aisLastMsgAt > 0 && now - aisLastMsgAt > 180000) {
      try {
        aisWs.close();
      } catch {
        /* already gone */
      }
      aisWs = null;
    } else {
      return;
    }
  }
  if (now < aisRetryAfter) return;
  if (aisProxy === undefined) {
    try {
      const r = await ctx.executePrivileged(privileged.getEgressProxy, {});
      aisProxy = r.proxy;
    } catch {
      aisProxy = null;
    }
  }
  try {
    // This network reaches the internet through an HTTP proxy (the
    // same one fetch honours internally). The WebSocket client does
    // NOT discover it by itself — pass it explicitly when one is
    // configured, connect directly otherwise.
    const Ctor = WebSocket as unknown as new (
      url: string,
      opts?: { proxy?: string },
    ) => WebSocket;
    const ws = aisProxy
      ? new Ctor(AISSTREAM_URL, { proxy: aisProxy })
      : new WebSocket(AISSTREAM_URL);
    aisWs = ws;
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            APIKey: AISSTREAM_API_KEY,
            BoundingBoxes: AIS_BOXES,
            FilterMessageTypes: ["PositionReport", "ShipStaticData"],
          }),
        );
      } catch {
        /* the close/error handlers own recovery */
      }
    };
    ws.onmessage = (ev) => {
      aisLastMsgAt = Date.now();
      // Frame payload shape depends on the runtime's WebSocket
      // implementation: string in Bun, possibly Blob / ArrayBuffer
      // in a spec-shaped worker. Normalise all three.
      const d: unknown = ev.data;
      if (typeof d === "string") {
        handleAisMessage(d);
      } else if (typeof Blob !== "undefined" && d instanceof Blob) {
        d.text().then(handleAisMessage).catch(() => undefined);
      } else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
        // This runtime delivers frames as Uint8Array views
        // (verified live: thousands of frames, all views).
        handleAisMessage(new TextDecoder().decode(d as ArrayBuffer));
      } else {
        handleAisMessage(d);
      }
    };
    const down = () => {
      if (aisWs === ws) {
        aisWs = null;
        aisRetryAfter = Date.now() + 30000;
      }
    };
    ws.onerror = down;
    ws.onclose = down;
  } catch {
    aisWs = null;
    aisRetryAfter = now + 30000;
  }
}

// Fold the live maps into the layer's ShipOut shape: position fields
// from the newest position report, identity/type/dimensions from
// the static report when one has been received for that MMSI.
function buildAisShips(): ShipOut[] {
  const out: ShipOut[] = [];
  for (const [id, p] of aisLivePos) {
    if (!shipReportFresh(p.at)) continue;
    const st = aisLiveStatic.get(id);
    const typeCode = st?.typeCode ?? null;
    out.push({
      id,
      name: st?.name ?? p.name,
      lat: p.lat,
      lng: p.lng,
      sogKn: shipSpeed(p.sog),
      cog: shipCourse(p.cog),
      heading: shipCourse(p.heading),
      kind: shipKindOf(typeCode),
      typeCode,
      typeLabel: shipTypeLabel(typeCode, null),
      imo: st?.imo ?? null,
      callsign: st?.callsign ?? null,
      dest: st?.dest ?? null,
      etaText: st?.etaText ?? null,
      draughtM: st?.draughtM ?? null,
      lenM: st?.lenM ?? null,
      beamM: st?.beamM ?? null,
      navStat: p.navStat != null && p.navStat !== 15 ? p.navStat : null,
      reportedAt: new Date(p.at).toISOString(),
    });
  }
  return out;
}

// ── Windy Webcams (global webcam layer) ─────────────────────────
//
// The Windy Webcams API key, from the WINDY_WEBCAMS_API_KEY
// environment variable (see .env.example). SERVER SIDE ONLY, same
// discipline as the keys above: it travels in the
// `x-windy-api-key` header from this process and is never returned
// by any action or embedded in the client. API v3 facts, verified
// live 2026-11-22 with this key: GET /webcams/api/v3/webcams takes
// `bbox=<north>,<east>,<south>,<west>` (the order is easy to get
// wrong — a north,south,east,west reading either 400s with
// "Invalid latitude value" or silently queries the wrong swath),
// `include=location,images,urls,categories`, and `limit` is capped
// at 50 per request on this plan (offset paginates); the catalogue
// holds ~69k active webcams.
// getWebcams sweeps region boxes (positions only — no image fields,
// so the payload stays small) and caches 30 minutes; getWebcam
// fetches ONE webcam's detail fresh on tap, because the free plan's
// image URLs are short-lived (~15 minutes) and must never be served
// stale from a cache. The largest image the plan returns is the
// 400×224 `preview` — the card shows it as-is and links out to the
// webcam's Windy page for the full view. Attribution: Windy.

const WINDY_WEBCAMS_API_KEY = process.env.WINDY_WEBCAMS_API_KEY ?? "";
const WINDY_WEBCAMS_API = "https://api.windy.com/webcams/api/v3/webcams";

interface WindyWebcamItem {
  webcamId?: number;
  title?: string;
  status?: string;
  viewCount?: number;
  lastUpdatedOn?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    city?: string;
    region?: string;
    country?: string;
  };
  images?: {
    current?: { preview?: string; thumbnail?: string };
    daylight?: { preview?: string };
  };
  urls?: { detail?: string; provider?: string };
  categories?: Array<{ name?: string }>;
}

interface WindyList {
  total?: number;
  webcams?: WindyWebcamItem[];
}

async function fetchWindyJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "EarthOnline-GlobalWeather/2.0",
        "x-windy-api-key": WINDY_WEBCAMS_API_KEY,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Region sweep for the layer's point set: bbox as
// [north, east, south, west] (the API's own order) + how many
// 50-item pages to pull (dense regions get more pages; results
// arrive most-viewed first, so extra pages still surface the
// watched places). ~16 requests per sweep, cached 30 minutes —
// webcam positions are static data.
const WEBCAM_REGIONS: Array<{
  bbox: [number, number, number, number];
  pages: number;
}> = [
  { bbox: [71, 32, 36, -12], pages: 3 }, // Europe
  { bbox: [54, 142, 18, 97], pages: 2 }, // East Asia
  { bbox: [72, -52, 14, -170], pages: 3 }, // North America
  { bbox: [55, 65, 35, 32], pages: 1 }, // W Russia / Caucasus / C Asia
  { bbox: [42, 63, 12, 34], pages: 1 }, // Middle East
  { bbox: [37, 97, 5, 61], pages: 1 }, // South Asia
  { bbox: [22, 142, -12, 92], pages: 1 }, // SE Asia
  { bbox: [12, -34, -56, -82], pages: 1 }, // South America
  { bbox: [37, 52, -35, -18], pages: 1 }, // Africa
  { bbox: [2, 180, -48, 110], pages: 1 }, // Oceania
  { bbox: [78, 180, 41, 65], pages: 1 }, // Russia north / east
];

// Windy place text: some records carry the literal string
// "unknown" for city/region — that is the absence of a name, not a
// name, so it decodes to null like any other missing field.
const windyText = (v: string | undefined): string | null => {
  const t = cleanShipText(v);
  return t && !/^unknown$/i.test(t) ? t : null;
};

const webcamOutSchema = z.object({
  id: z.string(),
  title: z.string(),
  lat: z.number(),
  lng: z.number(),
  city: z.string().nullable(),
  country: z.string().nullable(),
});

const webcamsResponse = z.object({
  ok: z.boolean(),
  count: z.number(),
  fetchedAt: z.string(),
  webcams: z.array(webcamOutSchema),
});

const webcamDetailResponse = z.object({
  ok: z.boolean(),
  title: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  imageUrl: z.string().nullable(),
  daylightUrl: z.string().nullable(),
  detailUrl: z.string().nullable(),
  providerUrl: z.string().nullable(),
  categories: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

let webcamsCache: { at: number; payload: z.infer<typeof webcamsResponse> } | null =
  null;

// ── Ship photos (detail-card background) ──────────────────────────
//
// The flight card's photo pattern, adapted to vessels: resolved
// lazily for the ONE tapped ship and cached in blob storage.
// Wikimedia Commons is the only reachable source — there is no
// Planespotters-for-ships in the free tier. Chain: (1) a Commons
// file search by the vessel's name, accepted only when the file's
// TITLE names the vessel (match 'ship' — a name match, weaker than
// the flight chain's registration match, and the card labels it as
// such); (2) a same-class photo from Commons (match 'type').
// 'none' rows retry after 7 days; photos are never invented and a
// miss leaves the card on its plain face.

const SHIP_PHOTO_NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const shipPhotoResponse = z.object({
  url: z.string().nullable(),
  pageUrl: z.string().nullable(),
  credit: z.string().nullable(),
  match: z.enum(["ship", "type"]).nullable(),
});

interface FoundShipPhoto {
  sourceUrl: string;
  pageUrl: string | null;
  credit: string | null;
  match: "ship" | "type";
}

interface CommonsShipSearch {
  query?: {
    pages?: Array<{
      title?: string;
      index?: number;
      imageinfo?: Array<{
        thumburl?: string;
        url?: string;
        width?: number;
        mime?: string;
        descriptionurl?: string;
        extmetadata?: { Artist?: { value?: string } };
      }>;
    }>;
  };
}

const SHIP_TYPE_SEARCH: Record<ShipKind, string> = {
  cargo: "container ship",
  tanker: "oil tanker ship",
  passenger: "passenger ship",
  fishing: "fishing vessel",
  other: "cargo ship",
};

async function commonsShipSearch(
  search: string,
  accept: (titleNorm: string) => boolean,
  match: "ship" | "type",
): Promise<FoundShipPhoto | null> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2" +
    "&generator=search&gsrnamespace=6&gsrlimit=8" +
    `&gsrsearch=${encodeURIComponent(search)}` +
    "&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600";
  const data = await fetchFastJson<CommonsShipSearch>(url, 9000);
  const pages = [...(data?.query?.pages ?? [])].sort(
    (a, b) => (a.index ?? 99) - (b.index ?? 99),
  );
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || info.mime !== "image/jpeg") continue;
    if ((info.width ?? 0) < 1000) continue;
    const titleNorm = (page.title ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!accept(titleNorm)) continue;
    const src = info.thumburl ?? info.url;
    if (!src) continue;
    const artist = info.extmetadata?.Artist?.value
      ? stripHtmlTags(info.extmetadata.Artist.value)
      : "";
    return {
      sourceUrl: src.split("?")[0] ?? src,
      pageUrl: info.descriptionurl ?? null,
      credit: artist.length > 0 ? artist : null,
      match,
    };
  }
  return null;
}

async function resolveShipPhoto(
  ctx: Ctx,
  mmsi: string,
  name: string | null,
  kind: ShipKind,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  let found: FoundShipPhoto | null = null;
  if (name) {
    const nameNorm = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (nameNorm.length >= 4) {
      found = await commonsShipSearch(
        `${name} ship`,
        (titleNorm) => titleNorm.includes(nameNorm),
        "ship",
      );
    }
  }
  if (!found) {
    found = await commonsShipSearch(
      SHIP_TYPE_SEARCH[kind],
      () => true,
      "type",
    );
  }
  const now = Date.now();
  if (!found) {
    await db
      .insert(schema.shipPhotos)
      .values({
        mmsi,
        sourceUrl: null,
        pageUrl: null,
        blobKey: null,
        credit: null,
        match: null,
        status: "none",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.shipPhotos.mmsi,
        set: {
          sourceUrl: null,
          pageUrl: null,
          blobKey: null,
          credit: null,
          match: null,
          status: "none",
          updatedAt: now,
        },
      });
    return;
  }
  let blobKey: string | null = null;
  const dl = await downloadImage(found.sourceUrl);
  if (dl) {
    blobKey = `ship-photos/${mmsi}`;
    await ctx.blobs.put(blobKey, dl.bytes, { contentType: dl.contentType });
  }
  await db
    .insert(schema.shipPhotos)
    .values({
      mmsi,
      sourceUrl: found.sourceUrl,
      pageUrl: found.pageUrl,
      blobKey,
      credit: found.credit,
      match: found.match,
      status: "ok",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.shipPhotos.mmsi,
      set: {
        sourceUrl: found.sourceUrl,
        pageUrl: found.pageUrl,
        blobKey,
        credit: found.credit,
        match: found.match,
        status: "ok",
        updatedAt: now,
      },
    });
}

// Successful-weather response cache (module memory): see the
// getCityWeather handler for the quota rationale. Successful
// extremes responses get the same treatment in getGlobalExtremes.
const weatherCache = new Map<
  string,
  { at: number; resp: z.infer<typeof weatherResponse> }
>();
let extremesCache: {
  at: number;
  sig: string;
  resp: z.infer<typeof extremesResponse>;
} | null = null;

export const Actions = {
  getCityWeather: defineAction({
    description:
      "Fetches live weather and air quality for one place from Open-Meteo (temperature, feels-like, humidity, wind, pressure, weather code, today's sunrise/sunset, PM2.5, PM10, US AQI). The two upstream calls run in parallel with independent 6s timeouts and one retry each; air quality is awaited only within a 7s budget — if it fails or times out, the card still returns ok:true with the PM/AQI fields null. tz may be an IANA zone or 'auto' (zone resolved from coordinates, returned as tzResolved). Successful responses are cached server-side for 5 minutes per coordinate cell to protect Open-Meteo's daily per-IP quota (the cached response keeps its original fetchedAt). Returns ok:false only when the forecast itself is unreachable, with quotaExceeded set when the cause is the daily quota (HTTP 429) — never fabricated values.",
    request: cityRef,
    response: weatherResponse,
    handler: async (
      _ctx,
      args,
    ): Promise<z.infer<typeof weatherResponse>> => {
      // Server-side 5-minute cache of successful responses, keyed by
      // ~100 m coordinate cell + zone: Open-Meteo's free tier meters
      // a daily quota per egress IP, and every card open used to cost
      // two fresh upstream calls per viewer. Within the window the
      // stored response is served with its ORIGINAL fetchedAt, so
      // the card's 更新于 line stays honest about the data's age.
      const cacheKey = `${args.lat.toFixed(3)}|${args.lng.toFixed(3)}|${args.tz}`;
      const hit = weatherCache.get(cacheKey);
      if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.resp;
      const fcUrl =
        "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${args.lat}&longitude=${args.lng}` +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,surface_pressure,precipitation" +
        "&daily=sunrise,sunset" +
        `&timezone=${encodeURIComponent(args.tz)}&forecast_days=2`;
      const aqUrl =
        "https://air-quality-api.open-meteo.com/v1/air-quality" +
        `?latitude=${args.lat}&longitude=${args.lng}` +
        "&current=pm2_5,pm10,us_aqi";

      // Parallel start, independent budgets (see fetchWeatherJson):
      // the forecast is awaited on its own retry-capped path; air
      // quality only within a 7s budget — its failure/timeout leaves
      // the PM fields null and never fails or stalls the card.
      const aqPromise = fetchWeatherJson<OmAirQuality>(aqUrl);
      const fcRes = await fetchWeatherJsonQ<OmForecast>(fcUrl);
      const fc = fcRes.data;
      const aq = await withBudget(aqPromise, 7000);

      if (!fc || !fc.current) {
        return {
          ok: false,
          temperature: null,
          apparentTemperature: null,
          humidity: null,
          weatherCode: null,
          isDay: null,
          windSpeed: null,
          pressure: null,
          precipitation: null,
          pm25: null,
          pm10: null,
          usAqi: null,
          sunrise: null,
          sunset: null,
          observedAt: null,
          fetchedAt: new Date().toISOString(),
          tzResolved: null,
          quotaExceeded: fcRes.quota,
        };
      }
      const c = fc.current;
      const resp: z.infer<typeof weatherResponse> = {
        ok: true,
        temperature: num(c.temperature_2m),
        apparentTemperature: num(c.apparent_temperature),
        humidity: num(c.relative_humidity_2m),
        weatherCode: num(c.weather_code),
        isDay: typeof c.is_day === "number" ? c.is_day === 1 : null,
        windSpeed: num(c.wind_speed_10m),
        pressure: num(c.surface_pressure),
        precipitation: num(c.precipitation),
        pm25: num(aq?.current?.pm2_5),
        pm10: num(aq?.current?.pm10),
        usAqi: num(aq?.current?.us_aqi),
        sunrise: hhmm(fc.daily?.sunrise?.[0]),
        sunset: hhmm(fc.daily?.sunset?.[0]),
        observedAt: c.time ?? null,
        fetchedAt: new Date().toISOString(),
        tzResolved:
          args.tz === "auto" && typeof fc.timezone === "string"
            ? fc.timezone
            : null,
        quotaExceeded: false,
      };
      weatherCache.set(cacheKey, { at: Date.now(), resp });
      return resp;
    },
  }),

  reverseGeocode: defineAction({
    description:
      "Names an arbitrary point on Earth (reverse geocoding via BigDataCloud, Chinese names): returns the locality, first-level admin region and country for the exact coordinates the user tapped on the globe. ok:false with null fields when the point has no known name (e.g. open ocean) — coordinates are then shown instead; names are never invented.",
    request: pointRef,
    response: geocodeResponse,
    handler: async (
      _ctx,
      args,
    ): Promise<z.infer<typeof geocodeResponse>> => {
      const url =
        "https://api.bigdatacloud.net/data/reverse-geocode-client" +
        `?latitude=${args.lat}&longitude=${args.lng}&localityLanguage=zh`;
      const d = await fetchBdc(url);
      if (!d) {
        return { ok: false, name: null, region: null, country: null };
      }
      const name = cleanName(d.city) ?? cleanName(d.locality);
      const region = cleanName(d.principalSubdivision);
      const country = cleanName(d.countryName);
      return {
        ok: name != null || region != null || country != null,
        name,
        region,
        country,
      };
    },
  }),

  getStreetView: defineAction({
    description:
      "Finds the nearest Mapillary street-level photo for a coordinate: queries a ~150 m box first, widens to ~500 m once, prefers the nearest panorama over regular photos, downloads the winner's bytes into this artifact's blob cache (Mapillary's signed URLs are bound to the requesting network and 403 everywhere else) and returns the blob URL plus real distance in metres, capture time and panorama flag. found:false on no coverage or any upstream failure — never an error, never fabricated.",
    request: pointRef,
    response: streetViewResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof streetViewResponse>> => {
      const empty: z.infer<typeof streetViewResponse> = {
        found: false,
        imageUrl: null,
        distanceM: null,
        capturedAt: null,
        isPano: null,
        imageId: null,
      };
      // Pick from one bbox query's metadata: only candidates we can
      // locate; panoramas preferred, nearest wins within the
      // preferred class; the winner's thumb URL is then fetched
      // (stage 2), walking down the preference order if a thumb
      // fetch fails. Null when nothing usable came back — including
      // "rows arrived but every one lacked geometry", which must
      // still trigger the wider retry.
      const pickBest = async (
        images: MlyImageMeta[],
      ): Promise<z.infer<typeof streetViewResponse> | null> => {
        const candidates = images
          .map((img) => {
            const coords = img.computed_geometry?.coordinates;
            if (
              !img.id ||
              !coords ||
              typeof coords[0] !== "number" ||
              typeof coords[1] !== "number"
            ) {
              return null;
            }
            return {
              id: img.id,
              isPano: img.is_pano === true,
              capturedAt:
                typeof img.captured_at === "number" &&
                Number.isFinite(img.captured_at)
                  ? new Date(img.captured_at).toISOString()
                  : null,
              distanceM: haversineM(args.lat, args.lng, coords[1], coords[0]),
            };
          })
          .filter((c): c is NonNullable<typeof c> => c != null);
        if (candidates.length === 0) return null;
        const panos = candidates.filter((c) => c.isPano);
        const pool = panos.length > 0 ? panos : candidates;
        pool.sort((a, b) => a.distanceM - b.distanceM);
        for (const cand of pool.slice(0, 3)) {
          // Deliver the image as OWNED bytes (see the delivery note
          // above): serve the blob cache when this image was cached
          // before; otherwise fetch its signed thumb URL from THIS
          // network context — the only one the URL works for —
          // download the bytes and cache them.
          const blobKey = `streetview/${cand.id}`;
          let imageUrl: string | null = null;
          const head = await ctx.blobs.head(blobKey).catch(() => null);
          if (head) {
            imageUrl = await ctx.blobs.getUrl(blobKey);
          } else {
            const thumbUrl = await fetchMlyThumb(cand.id);
            const dl = thumbUrl ? await downloadImage(thumbUrl) : null;
            if (dl) {
              await ctx.blobs.put(blobKey, dl.bytes, {
                contentType: dl.contentType,
              });
              imageUrl = await ctx.blobs.getUrl(blobKey);
            }
          }
          if (!imageUrl) continue;
          return {
            found: true,
            imageUrl,
            distanceM: Math.round(cand.distanceM),
            capturedAt: cand.capturedAt,
            isPano: cand.isPano,
            imageId: cand.id,
          };
        }
        return null;
      };
      const near = await pickBest(
        await fetchMlyImageMeta(args.lat, args.lng, 0.0015),
      );
      if (near) return near;
      const wide = await pickBest(
        await fetchMlyImageMeta(args.lat, args.lng, 0.005),
      );
      return wide ?? empty;
    },
  }),

  getCityPhoto: defineAction({
    description:
      "Returns the place's representative photo from the local cache (image bytes stored in this artifact, refreshed daily from the place's Wikipedia article lead image). Falls back to a live Wikipedia lookup for places with no cache row yet, caching the result for next time. url is null when the article has no usable image.",
    request: z.object({
      id: z.string().min(1).max(120),
      wiki: z.string().min(1).max(120),
      zh: z.string().min(1).max(40),
    }),
    response: photoResponse,
    handler: async (ctx, args): Promise<z.infer<typeof photoResponse>> => {
      const db = ctx.db<typeof schema>();
      const row = await db
        .select()
        .from(schema.cityPhotos)
        .where(eq(schema.cityPhotos.cityKey, args.id))
        .get();
      if (row) {
        if (row.status === "none") return { url: null, pageUrl: row.pageUrl };
        if (row.blobKey) {
          return {
            url: await ctx.blobs.getUrl(row.blobKey),
            pageUrl: row.pageUrl,
          };
        }
        // A row with metadata but no bytes (its download failed during
        // a refresh, or it predates the byte cache): fall through and
        // re-resolve now instead of handing out a possibly-dead link.
      }
      // No usable cache row: resolve live and cache the bytes for
      // next time.
      const status = await cachePlacePhoto(ctx, args.id, args.wiki, args.zh);
      if (status === "none") return { url: null, pageUrl: null };
      const fresh = await db
        .select()
        .from(schema.cityPhotos)
        .where(eq(schema.cityPhotos.cityKey, args.id))
        .get();
      if (fresh?.blobKey) {
        return {
          url: await ctx.blobs.getUrl(fresh.blobKey),
          pageUrl: fresh.pageUrl,
        };
      }
      return { url: fresh?.sourceUrl ?? null, pageUrl: fresh?.pageUrl ?? null };
    },
  }),

  refreshCityPhotos: defineAction({
    description:
      "Refreshes the local photo cache for every built-in city: re-reads each city's Wikipedia lead image, downloads the bytes into blob storage when the image changed or is missing, and records places whose articles have no usable image. Run daily by cron so weather cards always render photos from local storage instead of the Wikimedia CDN.",
    request: z.object({}),
    response: refreshPhotosResponse,
    handler: async (ctx): Promise<z.infer<typeof refreshPhotosResponse>> => {
      let withPhoto = 0;
      let withoutPhoto = 0;
      // Modest concurrency: Wikipedia + Wikimedia are public CDNs, but
      // 366 summaries + image downloads shouldn't burst like a crawler.
      const CONCURRENCY = 5;
      for (let i = 0; i < CITY_INDEX.length; i += CONCURRENCY) {
        const batch = CITY_INDEX.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (row) => {
            const status = await cachePlacePhoto(ctx, row.id, row.wiki, row.zh);
            if (status === "ok") withPhoto++;
            else withoutPhoto++;
          }),
        );
      }
      return {
        ok: true,
        total: CITY_INDEX.length,
        withPhoto,
        withoutPhoto,
        at: new Date().toISOString(),
      };
    },
  }),

  getEarthEvents: defineAction({
    description:
      "Live Earth event layer for the globe: USGS past-24h M4.5+ earthquakes (magnitude, depth, time, place, coordinates) plus NASA EONET open natural events limited to wildfires, volcanoes, severe storms and floods (title, category, latest position, start time, source link). Each upstream is fetched in parallel under its own timeout; a failed source returns its ok flag false with an empty list — never fabricated points.",
    request: z.object({}),
    response: earthEventsResponse,
    handler: async (): Promise<z.infer<typeof earthEventsResponse>> => {
      const usgsUrl =
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
      const cats: Array<{ id: string; limit: number }> = [
        { id: "wildfires", limit: 150 },
        { id: "volcanoes", limit: 50 },
        { id: "severeStorms", limit: 50 },
        { id: "floods", limit: 50 },
      ];
      const [usgs, ...eonetParts] = await Promise.all([
        fetchFastJson<UsgsFeed>(usgsUrl, 6000),
        ...cats.map((c) =>
          fetchFastJson<EonetFeed>(
            `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=${c.limit}&category=${c.id}`,
            8000,
          ),
        ),
      ]);
      const quakes: QuakeOut[] = [];
      if (usgs?.features) {
        for (const f of usgs.features) {
          const coords = f.geometry?.coordinates;
          const p = f.properties;
          if (
            !f.id ||
            !coords ||
            typeof coords[0] !== "number" ||
            typeof coords[1] !== "number" ||
            typeof p?.mag !== "number" ||
            typeof p?.time !== "number"
          ) {
            continue;
          }
          quakes.push({
            id: f.id,
            mag: p.mag,
            depth: typeof coords[2] === "number" ? coords[2] : null,
            place: typeof p.place === "string" ? p.place : "",
            time: p.time,
            lat: coords[1],
            lng: coords[0],
            url: typeof p.url === "string" ? p.url : null,
          });
          if (quakes.length >= 200) break;
        }
      }
      const events: NatEventOut[] = [];
      const seen = new Set<string>();
      for (const part of eonetParts) {
        if (!part?.events) continue;
        for (const ev of part.events) {
          if (!ev.id || seen.has(ev.id)) continue;
          const cat = ev.categories?.[0]?.id ?? "";
          if (
            cat !== "wildfires" &&
            cat !== "volcanoes" &&
            cat !== "severeStorms" &&
            cat !== "floods"
          ) {
            continue;
          }
          // Latest Point geometry wins; polygon-only events are
          // skipped (no invented centroid).
          let lat: number | null = null;
          let lng: number | null = null;
          let date: string | null = null;
          const geoms = ev.geometry ?? [];
          for (let i = geoms.length - 1; i >= 0; i--) {
            const g = geoms[i];
            if (
              g &&
              g.type === "Point" &&
              Array.isArray(g.coordinates) &&
              typeof g.coordinates[0] === "number" &&
              typeof g.coordinates[1] === "number"
            ) {
              lng = g.coordinates[0];
              lat = g.coordinates[1];
              date = typeof g.date === "string" ? g.date : null;
              break;
            }
          }
          if (lat == null || lng == null) continue;
          seen.add(ev.id);
          events.push({
            id: ev.id,
            title: typeof ev.title === "string" ? ev.title : "",
            category: cat,
            date: date ?? (typeof geoms[0]?.date === "string" ? geoms[0].date : null),
            lat,
            lng,
            link: typeof ev.link === "string" ? ev.link : null,
            sourceUrl:
              typeof ev.sources?.[0]?.url === "string"
                ? ev.sources[0].url
                : null,
          });
          if (events.length >= 300) break;
        }
        if (events.length >= 300) break;
      }
      return {
        quakesOk: usgs != null,
        eventsOk: eonetParts.some((p) => p != null),
        quakes,
        events,
        fetchedAt: new Date().toISOString(),
      };
    },
  }),

  getRainViewerMaps: defineAction({
    description:
      "RainViewer weather-maps index: the tile host plus the available past radar frames and satellite infrared frames (time + path each). The client composes the tiles into an equirectangular overlay for the globe and animates the radar frames. ok:false with empty frame lists when RainViewer is unreachable — the layers then stay hidden with a small note.",
    request: z.object({}),
    response: rainViewerResponse,
    handler: async (): Promise<z.infer<typeof rainViewerResponse>> => {
      const d = await fetchFastJson<RainViewerMaps>(
        "https://api.rainviewer.com/public/weather-maps.json",
        6000,
      );
      if (!d || typeof d.host !== "string") {
        return {
          ok: false,
          host: null,
          radarPast: [],
          satellite: [],
          fetchedAt: new Date().toISOString(),
        };
      }
      const frames = (
        list: Array<{ time?: number; path?: string }> | undefined,
      ) =>
        (Array.isArray(list) ? list : [])
          .filter(
            (f) => typeof f?.time === "number" && typeof f?.path === "string",
          )
          .map((f) => ({ time: f.time as number, path: f.path as string }));
      return {
        ok: true,
        host: d.host,
        radarPast: frames(d.radar?.past),
        satellite: frames(d.satellite?.infrared),
        fetchedAt: new Date().toISOString(),
      };
    },
  }),

  getGlobalExtremes: defineAction({
    description:
      "Computes the live global extremes over the built-in city library in two bulk Open-Meteo calls (one forecast call + one air-quality call for all points at once): hottest, coldest, windiest, rainiest, worst-air and best-air city, each with the same current-values caliber the weather card shows, so a champion's card always matches its榜 value. Successful responses are cached server-side for 10 minutes (a refresh is a 366-location bulk call against Open-Meteo's daily per-IP quota). ok:false only when the forecast bulk call fails, with quotaExceeded set when the cause is the daily quota; air extremes are null when the air-quality call fails.",
    request: extremesRequest,
    response: extremesResponse,
    handler: async (
      _ctx,
      args,
    ): Promise<z.infer<typeof extremesResponse>> => {
      // Server-side 10-minute cache of successful responses: one
      // refresh is a 366-location bulk call against Open-Meteo's
      // daily per-IP quota, and every open client used to fire its
      // own. The signature is the ordered point-id list (the client
      // always sends its full library in library order). A cached
      // response keeps its original fetchedAt.
      const sig = args.points.map((p) => p.id).join(",");
      if (
        extremesCache &&
        extremesCache.sig === sig &&
        Date.now() - extremesCache.at < 10 * 60 * 1000
      ) {
        return extremesCache.resp;
      }
      const lats = args.points.map((p) => p.lat).join(",");
      const lngs = args.points.map((p) => p.lng).join(",");
      const fcUrl =
        "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${lats}&longitude=${lngs}` +
        "&current=temperature_2m,wind_speed_10m,precipitation&timezone=auto";
      const aqUrl =
        "https://air-quality-api.open-meteo.com/v1/air-quality" +
        `?latitude=${lats}&longitude=${lngs}&current=pm2_5,us_aqi`;
      const aqPromise = fetchWeatherJson<OmBulkCurrent | OmBulkCurrent[]>(aqUrl);
      const fcRes = await fetchWeatherJsonQ<OmBulkCurrent | OmBulkCurrent[]>(fcUrl);
      const fcRaw = fcRes.data;
      const aqRaw = await withBudget(aqPromise, 7000);
      const fcList = fcRaw == null ? null : Array.isArray(fcRaw) ? fcRaw : [fcRaw];
      if (!fcList) {
        return {
          ok: false,
          quotaExceeded: fcRes.quota,
          count: 0,
          fetchedAt: new Date().toISOString(),
          hottest: null,
          coldest: null,
          windiest: null,
          rainiest: null,
          worstAir: null,
          bestAir: null,
        };
      }
      const aqList = aqRaw == null ? null : Array.isArray(aqRaw) ? aqRaw : [aqRaw];
      type Extreme = { id: string; value: number } | null;
      let hottest: Extreme = null;
      let coldest: Extreme = null;
      let windiest: Extreme = null;
      let rainiest: Extreme = null;
      let worstAir: Extreme = null;
      let bestAir: Extreme = null;
      let count = 0;
      for (let i = 0; i < args.points.length; i++) {
        const pt = args.points[i];
        const fc = fcList[i];
        if (!pt || !fc?.current) continue;
        count++;
        const t = num(fc.current.temperature_2m);
        const w = num(fc.current.wind_speed_10m);
        const r = num(fc.current.precipitation);
        if (t != null) {
          if (!hottest || t > hottest.value) hottest = { id: pt.id, value: t };
          if (!coldest || t < coldest.value) coldest = { id: pt.id, value: t };
        }
        if (w != null && (!windiest || w > windiest.value)) {
          windiest = { id: pt.id, value: w };
        }
        if (r != null && (!rainiest || r > rainiest.value)) {
          rainiest = { id: pt.id, value: r };
        }
        const aq = aqList?.[i];
        const pm = aq?.current ? num(aq.current.pm2_5) : null;
        if (pm != null) {
          if (!worstAir || pm > worstAir.value) worstAir = { id: pt.id, value: pm };
          if (!bestAir || pm < bestAir.value) bestAir = { id: pt.id, value: pm };
        }
      }
      // A "rainiest" champion at 0.0 mm would be a false claim —
      // when no library city is raining, the榜 honestly says so.
      if (rainiest && rainiest.value <= 0) rainiest = null;
      const resp: z.infer<typeof extremesResponse> = {
        ok: true,
        quotaExceeded: false,
        count,
        fetchedAt: new Date().toISOString(),
        hottest,
        coldest,
        windiest,
        rainiest,
        worstAir,
        bestAir,
      };
      extremesCache = { at: Date.now(), sig, resp };
      return resp;
    },
  }),

  getAurora: defineAction({
    description:
      "NOAA SWPC OVATION aurora forecast: the global 1° grid of aurora visibility probability for the model's forecast time, downsampled to points with probability ≥2 (threshold raised if needed to cap the payload) and shipped as flat [lng, lat, prob] triples, plus the model's observation/forecast timestamps. ok:false with an empty point list when NOAA is unreachable — the aurora layer then stays hidden; probabilities are never invented.",
    request: z.object({}),
    response: auroraResponse,
    handler: async (): Promise<z.infer<typeof auroraResponse>> => {
      const d = await fetchFastJson<OvationFeed>(
        "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
        10000,
      );
      const empty: z.infer<typeof auroraResponse> = {
        ok: false,
        observationTime: null,
        forecastTime: null,
        maxProb: 0,
        points: [],
        fetchedAt: new Date().toISOString(),
      };
      if (!d || !Array.isArray(d.coordinates)) return empty;
      let maxProb = 0;
      for (const c of d.coordinates) {
        if (typeof c[2] === "number" && c[2] > maxProb) maxProb = c[2];
      }
      // Threshold ladder: keep the payload ≤ ~16k points.
      let points: number[] = [];
      for (const th of [2, 3, 4, 5, 8, 12]) {
        points = [];
        for (const c of d.coordinates) {
          const lng0 = c[0];
          const lat = c[1];
          const v = c[2];
          if (
            typeof lng0 !== "number" ||
            typeof lat !== "number" ||
            typeof v !== "number" ||
            v < th
          ) {
            continue;
          }
          const lng = lng0 > 180 ? lng0 - 360 : lng0;
          points.push(Math.round(lng * 10) / 10, lat, v);
        }
        if (points.length <= 48000) break;
      }
      return {
        ok: true,
        observationTime: d["Observation Time"] ?? null,
        forecastTime: d["Forecast Time"] ?? null,
        maxProb,
        points,
        fetchedAt: new Date().toISOString(),
      };
    },
  }),

  getStations: defineAction({
    description:
      "Live positions of the ISS and the Chinese space station (Tiangong), propagated server-side with SGP4 from fresh TLEs (CelesTrak primary; the AMSAT mirror file serves when CelesTrak is unreachable from the server network, and the response's source field names the one that answered), each with a ±50-minute ground track, plus the next passes over Changsha (28.23°N, 112.94°E) in the next 72h: rise/peak/set times, peak elevation and azimuths, and a visible flag (peak in darkness for Changsha and the station sunlit). ok:false with empty lists when both TLE sources are unreachable — positions are never invented.",
    request: z.object({}),
    response: stationsResponse,
    handler: async (): Promise<z.infer<typeof stationsResponse>> => {
      const empty: z.infer<typeof stationsResponse> = {
        ok: false,
        fetchedAt: new Date().toISOString(),
        source: null,
        stations: [],
        passes: [],
      };
      const tle = await loadStationsTle();
      if (!tle) return empty;
      const text = tle.text;
      const defs: Array<{ id: string; name: string; norad: string }> = [
        { id: "iss", name: "国际空间站 ISS", norad: "25544" },
        { id: "css", name: "中国空间站·天宫", norad: "48274" },
      ];
      const now = new Date();
      const stations: z.infer<typeof stationSchema>[] = [];
      const recs = new Map<string, satellite.SatRec>();
      for (const def of defs) {
        const tle = findTle(text, def.norad);
        if (!tle) continue;
        let rec: satellite.SatRec;
        try {
          rec = satellite.twoline2satrec(tle[0], tle[1]);
        } catch {
          continue;
        }
        recs.set(def.id, rec);
        const pv = propagateAt(rec, now);
        const geo = pv ? geoOf(pv, now) : null;
        if (!pv || !geo) continue;
        const vel = pv.velocity
          ? Math.sqrt(
              pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2,
            ) * 3600
          : 0;
        const track: Array<[number, number]> = [];
        for (let m = -50; m <= 50; m += 2.5) {
          const d = new Date(now.getTime() + m * 60000);
          const p = propagateAt(rec, d);
          const g = p ? geoOf(p, d) : null;
          if (g) {
            track.push([
              Math.round(g.lng * 100) / 100,
              Math.round(g.lat * 100) / 100,
            ]);
          }
        }
        stations.push({
          id: def.id,
          name: def.name,
          lat: Math.round(geo.lat * 100) / 100,
          lng: Math.round(geo.lng * 100) / 100,
          altKm: Math.round(geo.altKm),
          velocityKmh: Math.round(vel),
          track,
        });
      }
      if (stations.length === 0) return empty;
      // Changsha passes: 72h scan at 30s steps, elevation > 10°.
      const OBS = { lat: 28.2282, lng: 112.9388 };
      const observer = {
        longitude: (OBS.lng * Math.PI) / 180,
        latitude: (OBS.lat * Math.PI) / 180,
        height: 0.05,
      };
      const passes: z.infer<typeof passSchema>[] = [];
      for (const def of defs) {
        const rec = recs.get(def.id);
        if (!rec) continue;
        let cur: {
          start: Date;
          riseAz: number;
          peak: Date;
          maxEl: number;
          peakAz: number;
          peakPv: PvOut;
          end: Date;
          setAz: number;
        } | null = null;
        const totalSteps = (72 * 3600) / 30;
        for (let s = 0; s <= totalSteps; s++) {
          const d = new Date(now.getTime() + s * 30000);
          const pv = propagateAt(rec, d);
          let el = -90;
          let az = 0;
          if (pv?.position) {
            try {
              const la = satellite.ecfToLookAngles(
                observer,
                satellite.eciToEcf(pv.position, satellite.gstime(d)),
              );
              el = (la.elevation * 180) / Math.PI;
              az = ((la.azimuth * 180) / Math.PI + 360) % 360;
            } catch {
              el = -90;
            }
          }
          if (el > 10) {
            if (!cur) {
              cur = {
                start: d,
                riseAz: az,
                peak: d,
                maxEl: el,
                peakAz: az,
                peakPv: pv as PvOut,
                end: d,
                setAz: az,
              };
            } else {
              cur.end = d;
              cur.setAz = az;
              if (el > cur.maxEl) {
                cur.maxEl = el;
                cur.peak = d;
                cur.peakAz = az;
                cur.peakPv = pv as PvOut;
              }
            }
          } else if (cur) {
            const visible =
              solarAltServer(OBS.lat, OBS.lng, cur.peak) < -3 &&
              stationSunlit(cur.peakPv, cur.peak);
            passes.push({
              stationId: def.id,
              start: cur.start.toISOString(),
              peak: cur.peak.toISOString(),
              end: cur.end.toISOString(),
              maxEl: Math.round(cur.maxEl),
              peakAz: Math.round(cur.peakAz),
              riseAz: Math.round(cur.riseAz),
              setAz: Math.round(cur.setAz),
              visible,
            });
            cur = null;
            if (passes.filter((p) => p.stationId === def.id).length >= 5) break;
          }
        }
      }
      passes.sort((a, b) => a.start.localeCompare(b.start));
      return {
        ok: true,
        fetchedAt: new Date().toISOString(),
        source: tle.source,
        stations,
        passes: passes.slice(0, 12),
      };
    },
  }),

  getFlights: defineAction({
    description:
      "Live airborne flights for the globe layer: OpenSky Network states are tried first; when OpenSky is unreachable from the server network (it currently drops this network after the TLS handshake), the action falls back to a sweep of 38 adsb.lol hub circles (250 NM) deduped by transponder hex — 23 of them over China (Beijing, Shanghai, Guangzhou plus the inland hubs Chengdu, Chongqing, Wuhan, Xi'an, Kunming, Shenyang, Urumqi, Changsha, Lanzhou, Harbin and the central infill Zhengzhou, Nanjing, Hangzhou, Hefei, Nanchang, Taiyuan, Hohhot, Guiyang, Nanning, Haikou) so the mainland interior is actually queried. Each flight carries a kind (airliner / bizjet / prop / heli) classified primarily from the ICAO type designator (business-jet and piston/turboprop type sets), with the ADS-B emitter category as fallback (A7 rotorcraft, A1 → prop, A2 → bizjet), so the globe can draw a distinct icon per class. When the feed exceeds the 1500 cap, a stratified sampler guarantees the rare kinds a floor share (heli 10%, prop 15%, bizjet 15% of the cap, up to their actual population) instead of thinning every kind proportionally, and a regional floor reserves 25% of the cap for the China airspace box (lat 18–54, lng 73–135) so dense US/EU traffic cannot thin the mainland out. The response's source field names whichever source actually served, results are cached 45s server-side, and ok:false with an empty list is returned when both sources fail — flight positions are never invented.",
    request: z.object({}),
    response: flightsResponse,
    handler: async (): Promise<z.infer<typeof flightsResponse>> => {
      if (flightsCache && Date.now() - flightsCache.at < 45000) {
        return flightsCache.payload;
      }
      const empty: z.infer<typeof flightsResponse> = {
        ok: false,
        source: null,
        count: 0,
        fetchedAt: new Date().toISOString(),
        flights: [],
      };
      // Primary: OpenSky global states.
      let payload: z.infer<typeof flightsResponse> | null = null;
      const os = await fetchFastJson<OpenSkyStates>(
        "https://opensky-network.org/api/states/all",
        7000,
      );
      if (os?.states && os.states.length > 0) {
        const out: FlightOut[] = [];
        for (const s of os.states) {
          const lng = s[5];
          const lat = s[6];
          if (typeof lat !== "number" || typeof lng !== "number") continue;
          if (s[8] === true) continue; // on ground
          out.push({
            id: typeof s[0] === "string" ? s[0] : `${lng},${lat}`,
            callsign:
              typeof s[1] === "string" &&
              s[1].trim().length > 0 &&
              !s[1].includes("@")
                ? s[1].trim()
                : null,
            lat,
            lng,
            altM: typeof s[7] === "number" ? Math.round(s[7]) : null,
            speedKmh: typeof s[9] === "number" ? Math.round(s[9] * 3.6) : null,
            heading: typeof s[10] === "number" ? Math.round(s[10]) : null,
            // OpenSky state field 11 is vertical rate, already m/s.
            vrateMs:
              typeof s[11] === "number"
                ? Math.round(s[11] * 10) / 10
                : null,
            detail: typeof s[2] === "string" ? s[2] : "",
            // OpenSky state vectors carry no type/category — the
            // paper-plane (airliner) glyph is the honest default.
            kind: "airliner",
            // Nor registration/type: the card's photo lookup then
            // keys off the transponder hex alone.
            reg: null,
            type: null,
          });
        }
        if (out.length > 0) {
          const capped = sampleCap(out, 1500);
          payload = {
            ok: true,
            source: "opensky",
            count: capped.length,
            fetchedAt: new Date().toISOString(),
            flights: capped,
          };
        }
      }
      // Fallback: adsb.lol hub sweep.
      if (!payload) {
        const parts = await Promise.all(
          ADSB_HUBS.map(([la, lo]) =>
            fetchFastJson<AdsbResp>(
              `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/250`,
              8000,
            ),
          ),
        );
        const byHex = new Map<string, FlightOut>();
        for (const part of parts) {
          if (!part?.ac) continue;
          for (const a of part.ac) {
            if (
              !a.hex ||
              typeof a.lat !== "number" ||
              typeof a.lon !== "number" ||
              byHex.has(a.hex)
            ) {
              continue;
            }
            byHex.set(a.hex, {
              id: a.hex,
              callsign:
                typeof a.flight === "string" &&
                a.flight.trim().length > 0 &&
                !a.flight.includes("@")
                  ? a.flight.trim()
                  : null,
              lat: a.lat,
              lng: a.lon,
              altM:
                typeof a.alt_baro === "number"
                  ? Math.round(a.alt_baro * 0.3048)
                  : null,
              speedKmh:
                typeof a.gs === "number" ? Math.round(a.gs * 1.852) : null,
              heading:
                typeof a.track === "number" ? Math.round(a.track) : null,
              // readsb vertical rates are ft/min → m/s (×0.00508).
              vrateMs:
                typeof a.baro_rate === "number"
                  ? Math.round(a.baro_rate * 0.00508 * 10) / 10
                  : typeof a.geom_rate === "number"
                    ? Math.round(a.geom_rate * 0.00508 * 10) / 10
                    : null,
              detail: [a.t, a.r].filter(Boolean).join(" · "),
              kind: flightKind(a.category, a.t),
              reg:
                typeof a.r === "string" && a.r.trim().length > 0
                  ? a.r.trim()
                  : null,
              type:
                typeof a.t === "string" && a.t.trim().length > 0
                  ? a.t.trim().toUpperCase()
                  : null,
            });
          }
        }
        const all = [...byHex.values()];
        if (all.length > 0) {
          const capped = sampleCap(all, 1500);
          payload = {
            ok: true,
            source: "adsb.lol",
            count: capped.length,
            fetchedAt: new Date().toISOString(),
            flights: capped,
          };
        }
      }
      const result = payload ?? empty;
      if (result.ok) flightsCache = { at: Date.now(), payload: result };
      return result;
    },
  }),

  getFlightPhoto: defineAction({
    description:
      "Photo for ONE tapped aircraft's detail card, resolved lazily on tap and cached in blob storage (never pre-fetched for the flight layer): first the full-size airport-data.com photo linked from the adsbdb aircraft record (~1400px, this exact airframe), then the Planespotters public API by registration and by transponder hex (this exact airframe, its latest photo, photographer credited, 498px), falling back to a Wikimedia Commons photo of the same aircraft type (match='type', artist as credit). Rows cached under the pre-#38 chain are re-resolved once so old cards upgrade to the sharper photo. url is null when no source has a photo — the card then keeps its plain background; upstream failures degrade to null silently.",
    request: z.object({
      id: z.string().min(1).max(32),
      reg: z.string().max(16).nullable(),
      type: z.string().max(12).nullable(),
    }),
    response: flightPhotoResponse,
    handler: async (ctx, args): Promise<z.infer<typeof flightPhotoResponse>> => {
      const db = ctx.db<typeof schema>();
      const hex = args.id.toLowerCase();
      let row = await db
        .select()
        .from(schema.flightPhotos)
        .where(eq(schema.flightPhotos.hex, hex))
        .get();
      const staleNone =
        row?.status === "none" &&
        Date.now() - row.updatedAt > FLIGHT_PHOTO_NONE_TTL_MS;
      const unusableOk =
        row?.status === "ok" && !row.blobKey && !row.sourceUrl;
      const preHdChain =
        row?.status === "ok" && row.updatedAt < FLIGHT_PHOTO_HD_EPOCH_MS;
      if (!row || staleNone || unusableOk || preHdChain) {
        await resolveFlightPhoto(
          ctx,
          hex,
          args.reg,
          args.type ? args.type.toUpperCase() : null,
        );
        row = await db
          .select()
          .from(schema.flightPhotos)
          .where(eq(schema.flightPhotos.hex, hex))
          .get();
      }
      if (!row || row.status === "none") {
        return { url: null, pageUrl: null, credit: null, match: null, source: null };
      }
      return {
        url: row.blobKey
          ? await ctx.blobs.getUrl(row.blobKey)
          : row.sourceUrl,
        pageUrl: row.pageUrl,
        credit: row.credit,
        match: row.match,
        source: !row.sourceUrl
          ? null
          : row.sourceUrl.includes("airport-data.com")
            ? "airport-data"
            : row.sourceUrl.includes("plnspttrs.net")
              ? "planespotters"
              : row.match === "type"
                ? "commons"
                : null,
      };
    },
  }),

  getFlightRoute: defineAction({
    description:
      "Origin/destination for ONE tapped flight's detail card, reverse-looked-up by callsign in the adsbdb public route database and cached per callsign in flight_routes (never pre-fetched for the flight layer). Returns the origin/destination city, airport name and IATA code exactly as adsbdb reports them; found:false when adsbdb has no route for the callsign — the card then shows 未知 and no route is ever invented. Stale rows re-validate after 30 days ('ok') or 7 days ('none'); upstream failures degrade to found:false silently.",
    request: z.object({
      callsign: z.string().min(3).max(12),
    }),
    response: flightRouteResponse,
    handler: async (ctx, args): Promise<z.infer<typeof flightRouteResponse>> => {
      const db = ctx.db<typeof schema>();
      const callsign = args.callsign.trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(callsign)) {
        return { found: false, origin: null, destination: null };
      }
      let row = await db
        .select()
        .from(schema.flightRoutes)
        .where(eq(schema.flightRoutes.callsign, callsign))
        .get();
      const stale =
        !row ||
        (row.status === "ok" &&
          Date.now() - row.updatedAt > FLIGHT_ROUTE_OK_TTL_MS) ||
        (row.status === "none" &&
          Date.now() - row.updatedAt > FLIGHT_ROUTE_NONE_TTL_MS);
      if (stale) {
        const found = await lookupAdsbdbRoute(callsign);
        const now = Date.now();
        const values = {
          callsign,
          originCity: found?.origin.city ?? null,
          originName: found?.origin.name ?? null,
          originIata: found?.origin.iata ?? null,
          destCity: found?.destination.city ?? null,
          destName: found?.destination.name ?? null,
          destIata: found?.destination.iata ?? null,
          status: (found ? "ok" : "none") as "ok" | "none",
          updatedAt: now,
        };
        await db
          .insert(schema.flightRoutes)
          .values(values)
          .onConflictDoUpdate({
            target: schema.flightRoutes.callsign,
            set: {
              originCity: values.originCity,
              originName: values.originName,
              originIata: values.originIata,
              destCity: values.destCity,
              destName: values.destName,
              destIata: values.destIata,
              status: values.status,
              updatedAt: now,
            },
          });
        row = await db
          .select()
          .from(schema.flightRoutes)
          .where(eq(schema.flightRoutes.callsign, callsign))
          .get();
      }
      if (!row || row.status === "none") {
        return { found: false, origin: null, destination: null };
      }
      return {
        found: true,
        origin: {
          city: row.originCity,
          name: row.originName,
          iata: row.originIata,
        },
        destination: {
          city: row.destCity,
          name: row.destName,
          iata: row.destIata,
        },
      };
    },
  }),

  getFlightAircraft: defineAction({
    description:
      "Archive record for ONE tapped aircraft's detail card （运营方/operator, registry country, full type variant, manufacturer), looked up by transponder hex in the adsbdb public aircraft database and cached per hex in flight_aircraft (never pre-fetched for the flight layer). found:false when adsbdb has no record for the hex — the card then shows 未知 and nothing is invented. No source reachable from the server carries a manufacture year, so no aircraft-age field exists. Stale rows re-validate after 30 days ('ok') or 7 days ('none'); upstream failures degrade to found:false silently.",
    request: z.object({
      id: z.string().min(1).max(32),
    }),
    response: flightAircraftResponse,
    handler: async (ctx, args): Promise<z.infer<typeof flightAircraftResponse>> => {
      const db = ctx.db<typeof schema>();
      const hex = args.id.trim().toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) {
        return {
          found: false,
          typeFull: null,
          manufacturer: null,
          owner: null,
          country: null,
          countryIso: null,
        };
      }
      let row = await db
        .select()
        .from(schema.flightAircraft)
        .where(eq(schema.flightAircraft.hex, hex))
        .get();
      const stale =
        !row ||
        (row.status === "ok" &&
          Date.now() - row.updatedAt > FLIGHT_AIRCRAFT_OK_TTL_MS) ||
        (row.status === "none" &&
          Date.now() - row.updatedAt > FLIGHT_AIRCRAFT_NONE_TTL_MS);
      if (stale) {
        const found = await lookupAdsbdbAircraft(hex);
        const now = Date.now();
        const values = {
          hex,
          typeFull: found?.typeFull ?? null,
          manufacturer: found?.manufacturer ?? null,
          registration: found?.registration ?? null,
          owner: found?.owner ?? null,
          ownerCountry: found?.ownerCountry ?? null,
          ownerCountryIso: found?.ownerCountryIso ?? null,
          status: (found ? "ok" : "none") as "ok" | "none",
          updatedAt: now,
        };
        await db
          .insert(schema.flightAircraft)
          .values(values)
          .onConflictDoUpdate({
            target: schema.flightAircraft.hex,
            set: {
              typeFull: values.typeFull,
              manufacturer: values.manufacturer,
              registration: values.registration,
              owner: values.owner,
              ownerCountry: values.ownerCountry,
              ownerCountryIso: values.ownerCountryIso,
              status: values.status,
              updatedAt: now,
            },
          });
        row = await db
          .select()
          .from(schema.flightAircraft)
          .where(eq(schema.flightAircraft.hex, hex))
          .get();
      }
      if (!row || row.status === "none") {
        return {
          found: false,
          typeFull: null,
          manufacturer: null,
          owner: null,
          country: null,
          countryIso: null,
        };
      }
      return {
        found: true,
        typeFull: row.typeFull,
        manufacturer: row.manufacturer,
        owner: row.owner,
        country: row.ownerCountry,
        countryIso: row.ownerCountryIso,
      };
    },
  }),

  getShips: defineAction({
    description:
      "Live vessel positions (AIS) for the globe's ship layer. Primary source is aisstream.io's global WebSocket stream, keyed with the user's own API key held server-side only: a persistent collector folds PositionReport + ShipStaticData messages from the world's major shipping boxes into an in-memory snapshot (a cold process waits up to ~7s for the stream to warm before answering). When the stream yields nothing, facha.dev (free, no key) is swept over 16 port/strait hub circles of 120 km radius and deduped by MMSI; when it also yields nothing (its backend was answering 502 at build time), the action falls back to Digitraffic's open AIS API (Finnish Transport Infrastructure Agency), whose locations feed is merged with its vessel-metadata feed by MMSI — Baltic coverage only. The response's source field names whichever source actually served. Each ship carries name, AIS type code + Chinese type label + icon kind (cargo/tanker/passenger/fishing/other), speed/course/heading, IMO, call sign, crew-declared destination and ETA, draught, length/beam derived from the AIS dimension offsets, navigational status and report time. Results are cached 60s server-side, capped at 1500, and ok:false with an empty list is returned when both sources fail — positions are never invented, and open-ocean sparsity is the AIS system's physical limit. Every report passes two sanity gates before it is plotted: it must be fresh (timestamp at most 60 minutes old — the feeds carry stale and spoofed receptions, including positions deep inland, hours after the vessel stopped reporting) and its claimed speed must be physically possible (a raw SOG strictly between 45 kn and the 102.2 'not available' sentinel marks the whole report corrupt; the sentinel itself only hides the speed, never the position).",
    request: z.object({}),
    response: shipsResponse,
    privileged: [privileged.getEgressProxy],
    handler: async (ctx): Promise<z.infer<typeof shipsResponse>> => {
      if (shipsCache && Date.now() - shipsCache.at < 60000) {
        return shipsCache.payload;
      }
      const empty: z.infer<typeof shipsResponse> = {
        ok: false,
        source: null,
        count: 0,
        fetchedAt: new Date().toISOString(),
        ships: [],
      };
      let payload: z.infer<typeof shipsResponse> | null = null;
      // Primary: the aisstream.io collector's live snapshot. On a
      // cold process the stream needs a few seconds to accumulate
      // reports — wait briefly for a usable snapshot before falling
      // through to the keyless sources.
      await ensureAisStream(ctx);
      if (aisLivePos.size < 50) {
        const deadline = Date.now() + 7000;
        while (aisLivePos.size < 50 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          await ensureAisStream(ctx);
        }
      }
      if (aisLivePos.size > 0) {
        const aisShips = buildAisShips();
        if (aisShips.length > 0) {
          // Sample by MMSI hash order, not arrival order: the
          // stream's first minutes over-represent whichever box
          // delivered first, while a hash stride draws the 1500-cap
          // uniformly from everything heard in the last hour.
          aisShips.sort(
            (a, b) =>
              ((Number(a.id) * 2654435761) % 4294967296) -
              ((Number(b.id) * 2654435761) % 4294967296),
          );
          const capped = strideSampleShips(aisShips, 1500);
          payload = {
            ok: true,
            source: "aisstream.io",
            count: capped.length,
            fetchedAt: new Date().toISOString(),
            ships: capped,
          };
        }
      }
      // Second: facha.dev hub sweep (skipped when aisstream served).
      const parts = payload
        ? []
        : await Promise.all(
        SHIP_HUBS.map(([la, lo]) =>
          fetchFastJson<FachaShip[]>(
            `https://api.facha.dev/v1/ship/radius/${la}/${lo}/120`,
            7000,
          ),
        ),
      );
      const byMmsi = new Map<string, ShipOut>();
      for (const part of parts) {
        if (!Array.isArray(part)) continue;
        for (const s of part) {
          if (
            typeof s.mmsi !== "number" ||
            typeof s.latitude !== "number" ||
            typeof s.longitude !== "number" ||
            byMmsi.has(String(s.mmsi))
          ) {
            continue;
          }
          // Sanity gates (see shipReportFresh): a timestamp that
          // parses AND proves the report stale drops it; a corrupt
          // claimed speed drops it outright.
          const fachaTs =
            typeof s.timestamp === "string" ? Date.parse(s.timestamp) : NaN;
          if (Number.isFinite(fachaTs) && !shipReportFresh(fachaTs)) {
            continue;
          }
          if (!shipClaimedSpeedSane(s.speedOverGround)) continue;
          const typeCode = typeof s.type === "number" ? s.type : null;
          const len =
            (s.dimensionToBow ?? 0) + (s.dimensionToStern ?? 0);
          const beam =
            (s.dimensionToPort ?? 0) + (s.dimensionToStarboard ?? 0);
          byMmsi.set(String(s.mmsi), {
            id: String(s.mmsi),
            name: cleanShipText(s.name),
            lat: s.latitude,
            lng: s.longitude,
            sogKn: shipSpeed(s.speedOverGround),
            cog: shipCourse(s.courseOverGround),
            heading: shipCourse(s.heading),
            kind: shipKindOf(typeCode),
            typeCode,
            typeLabel: shipTypeLabel(typeCode, s.vesselType ?? null),
            imo:
              typeof s.imoNumber === "number" && s.imoNumber > 0
                ? s.imoNumber
                : null,
            callsign: cleanShipText(s.callSign),
            dest: cleanShipText(s.destination),
            etaText: fachaEtaText(s.estimatedTimeOfArrival),
            draughtM:
              typeof s.draught === "number" && s.draught > 0
                ? Math.round(s.draught * 10) / 10
                : null,
            lenM: len > 0 ? len : null,
            beamM: beam > 0 ? beam : null,
            navStat:
              typeof s.navigationalStatus === "number" &&
              s.navigationalStatus !== 15
                ? s.navigationalStatus
                : null,
            reportedAt:
              typeof s.timestamp === "string" ? s.timestamp : null,
          });
        }
      }
      if (byMmsi.size > 0) {
        const capped = strideSampleShips([...byMmsi.values()], 1500);
        payload = {
          ok: true,
          source: "facha.dev",
          count: capped.length,
          fetchedAt: new Date().toISOString(),
          ships: capped,
        };
      }
      // Fallback: Digitraffic (Baltic) locations + vessel metadata.
      if (!payload) {
        const [loc, ves] = await Promise.all([
          fetchFastJson<DtLocations>(
            "https://meri.digitraffic.fi/api/ais/v1/locations",
            9000,
          ),
          fetchFastJson<DtVessel[]>(
            "https://meri.digitraffic.fi/api/ais/v1/vessels",
            9000,
          ),
        ]);
        const meta = new Map<number, DtVessel>();
        if (Array.isArray(ves)) {
          for (const v of ves) {
            if (typeof v.mmsi === "number") meta.set(v.mmsi, v);
          }
        }
        const out: ShipOut[] = [];
        for (const f of loc?.features ?? []) {
          const coords = f.geometry?.coordinates;
          if (
            typeof f.mmsi !== "number" ||
            !coords ||
            typeof coords[0] !== "number" ||
            typeof coords[1] !== "number"
          ) {
            continue;
          }
          const v = meta.get(f.mmsi);
          const p = f.properties ?? {};
          // Sanity gates (see shipReportFresh): stale or
          // impossible-speed reports never reach the globe — this
          // is what plotted spoofed positions deep inland.
          if (!shipReportFresh(p.timestampExternal)) continue;
          if (!shipClaimedSpeedSane(p.sog)) continue;
          const typeCode =
            typeof v?.shipType === "number" ? v.shipType : null;
          const len =
            (v?.referencePointA ?? 0) + (v?.referencePointB ?? 0);
          const beam =
            (v?.referencePointC ?? 0) + (v?.referencePointD ?? 0);
          out.push({
            id: String(f.mmsi),
            name: cleanShipText(v?.name),
            lat: coords[1],
            lng: coords[0],
            sogKn: shipSpeed(p.sog),
            cog: shipCourse(p.cog),
            heading: shipCourse(p.heading),
            kind: shipKindOf(typeCode),
            typeCode,
            typeLabel: shipTypeLabel(typeCode, null),
            imo:
              typeof v?.imo === "number" && v.imo > 0 ? v.imo : null,
            callsign: cleanShipText(v?.callSign),
            dest: cleanShipText(v?.destination),
            etaText: digitrafficEtaText(v?.eta),
            // Digitraffic carries the AIS-standard decimetre draught.
            draughtM:
              typeof v?.draught === "number" && v.draught > 0
                ? Math.round(v.draught) / 10
                : null,
            lenM: len > 0 ? len : null,
            beamM: beam > 0 ? beam : null,
            navStat:
              typeof p.navStat === "number" && p.navStat !== 15
                ? p.navStat
                : null,
            reportedAt:
              typeof p.timestampExternal === "number" &&
              Number.isFinite(p.timestampExternal)
                ? new Date(p.timestampExternal).toISOString()
                : null,
          });
        }
        if (out.length > 0) {
          const capped = strideSampleShips(out, 1500);
          payload = {
            ok: true,
            source: "digitraffic",
            count: capped.length,
            fetchedAt: new Date().toISOString(),
            ships: capped,
          };
        }
      }
      const result = payload ?? empty;
      if (result.ok) shipsCache = { at: Date.now(), payload: result };
      return result;
    },
  }),

  getShipPhoto: defineAction({
    description:
      "Photo for ONE tapped vessel's detail card, resolved lazily on tap and cached in blob storage (never pre-fetched for the ship layer): first a Wikimedia Commons file whose title names this vessel (match='ship', a name match — labelled as such on the card), falling back to a Commons photo of the same vessel class (match='type', artist credited). url is null when Commons has neither — the card then keeps its plain background; upstream failures degrade to null silently. 'none' rows re-validate after 7 days.",
    request: z.object({
      mmsi: z.string().min(1).max(16),
      name: z.string().max(80).nullable(),
      kind: z.enum(["cargo", "tanker", "passenger", "fishing", "other"]),
    }),
    response: shipPhotoResponse,
    handler: async (ctx, args): Promise<z.infer<typeof shipPhotoResponse>> => {
      const db = ctx.db<typeof schema>();
      const mmsi = args.mmsi.trim();
      if (!/^\d{5,12}$/.test(mmsi)) {
        return { url: null, pageUrl: null, credit: null, match: null };
      }
      let row = await db
        .select()
        .from(schema.shipPhotos)
        .where(eq(schema.shipPhotos.mmsi, mmsi))
        .get();
      const staleNone =
        row?.status === "none" &&
        Date.now() - row.updatedAt > SHIP_PHOTO_NONE_TTL_MS;
      const unusableOk =
        row?.status === "ok" && !row.blobKey && !row.sourceUrl;
      if (!row || staleNone || unusableOk) {
        await resolveShipPhoto(ctx, mmsi, args.name, args.kind);
        row = await db
          .select()
          .from(schema.shipPhotos)
          .where(eq(schema.shipPhotos.mmsi, mmsi))
          .get();
      }
      if (!row || row.status === "none") {
        return { url: null, pageUrl: null, credit: null, match: null };
      }
      return {
        url: row.blobKey
          ? await ctx.blobs.getUrl(row.blobKey)
          : row.sourceUrl,
        pageUrl: row.pageUrl,
        credit: row.credit,
        match: row.match,
      };
    },
  }),

  getWebcams: defineAction({
    description:
      "Global webcam positions for the globe's webcam layer, from the Windy Webcams API v3 (the user's own API key, held server-side only and sent as a request header): region bounding boxes are swept at 50 items per page (the plan's per-request cap), most-viewed first, deduped by webcam id, active webcams only, capped at 1000 and cached 30 minutes server-side. Only positions and titles are returned — image URLs are short-lived on the free plan and are resolved per webcam by getWebcam at tap time. ok:false with an empty list when Windy is unreachable; positions are never invented.",
    request: z.object({}),
    response: webcamsResponse,
    handler: async (): Promise<z.infer<typeof webcamsResponse>> => {
      if (webcamsCache && Date.now() - webcamsCache.at < 30 * 60 * 1000) {
        return webcamsCache.payload;
      }
      const jobs: Array<Promise<WindyList | null>> = [];
      for (const r of WEBCAM_REGIONS) {
        const [n, e, s, w] = r.bbox;
        for (let pg = 0; pg < r.pages; pg++) {
          jobs.push(
            fetchWindyJson<WindyList>(
              `${WINDY_WEBCAMS_API}?limit=50&offset=${pg * 50}` +
                `&include=location&bbox=${n},${e},${s},${w}`,
              12000,
            ),
          );
        }
      }
      const lists = await Promise.all(jobs);
      const byId = new Map<
        string,
        { item: WindyWebcamItem; views: number }
      >();
      for (const list of lists) {
        for (const item of list?.webcams ?? []) {
          if (
            typeof item.webcamId !== "number" ||
            item.status !== "active" ||
            typeof item.location?.latitude !== "number" ||
            typeof item.location?.longitude !== "number"
          ) {
            continue;
          }
          const id = String(item.webcamId);
          const views =
            typeof item.viewCount === "number" ? item.viewCount : 0;
          const prev = byId.get(id);
          if (!prev || views > prev.views) byId.set(id, { item, views });
        }
      }
      const sorted = [...byId.values()].sort((a, b) => b.views - a.views);
      const webcams = sorted.slice(0, 1000).map(({ item }) => ({
        id: String(item.webcamId),
        title:
          typeof item.title === "string" && item.title.trim().length > 0
            ? item.title.trim()
            : "网络摄像头",
        lat: item.location?.latitude ?? 0,
        lng: item.location?.longitude ?? 0,
        city: windyText(item.location?.city),
        country: windyText(item.location?.country),
      }));
      const payload: z.infer<typeof webcamsResponse> = {
        ok: webcams.length > 0,
        count: webcams.length,
        fetchedAt: new Date().toISOString(),
        webcams,
      };
      if (payload.ok) webcamsCache = { at: Date.now(), payload };
      return payload;
    },
  }),

  getWebcam: defineAction({
    description:
      "One webcam's detail for its card, fetched FRESH from the Windy Webcams API v3 on every call (the user's key, server-side header only): title, city/region/country, coordinates, the current preview image URL (the free plan's largest size, 400×224 — its links are short-lived, ~15 minutes, so nothing is cached), the daylight preview, category names, the last-update time and the webcam's Windy page URL for the full view. ok:false with null fields when Windy has no such webcam or is unreachable — nothing is fabricated.",
    request: z.object({ id: z.string().min(1).max(20) }),
    response: webcamDetailResponse,
    handler: async (_ctx, args): Promise<z.infer<typeof webcamDetailResponse>> => {
      const empty: z.infer<typeof webcamDetailResponse> = {
        ok: false,
        title: null,
        city: null,
        region: null,
        country: null,
        lat: null,
        lng: null,
        imageUrl: null,
        daylightUrl: null,
        detailUrl: null,
        providerUrl: null,
        categories: [],
        updatedAt: null,
      };
      const id = args.id.trim();
      if (!/^\d{1,20}$/.test(id)) return empty;
      const item = await fetchWindyJson<WindyWebcamItem>(
        `${WINDY_WEBCAMS_API}/${encodeURIComponent(id)}` +
          `?include=location,images,urls,categories`,
        12000,
      );
      if (!item || typeof item.webcamId !== "number") return empty;
      return {
        ok: true,
        title: cleanShipText(item.title),
        city: windyText(item.location?.city),
        region: windyText(item.location?.region),
        country: windyText(item.location?.country),
        lat:
          typeof item.location?.latitude === "number"
            ? item.location.latitude
            : null,
        lng:
          typeof item.location?.longitude === "number"
            ? item.location.longitude
            : null,
        imageUrl:
          item.images?.current?.preview ??
          item.images?.current?.thumbnail ??
          null,
        daylightUrl: item.images?.daylight?.preview ?? null,
        detailUrl: item.urls?.detail ?? null,
        providerUrl: item.urls?.provider ?? null,
        categories: (item.categories ?? [])
          .map((c) => cleanShipText(c.name))
          .filter((c): c is string => c != null),
        updatedAt:
          typeof item.lastUpdatedOn === "string" ? item.lastUpdatedOn : null,
      };
    },
  }),
} satisfies ActionsModule;
