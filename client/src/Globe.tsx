// 3D globe for the global-weather desk: the same realistic Blue Marble
// terrain sphere (white snowcaps, green forests, deep-blue oceans, fixed
// sun, drifting clouds, national borders, Chinese country labels, China
// province boundaries at closer range) — but the plotted layer is now the
// built-in library of ~366 mid/large cities, not news events.
//
// Zoom-tier strategy (the fix for "labels don't scale with the map"):
// camera distance defines five bands —
//   L1 (far):  only whitelisted megacities/major capitals (city.labelTier
//              1) show a name plate — its plate is demoted to L2 for the
//              dense-cluster tier-1 cities (see cities.ts), so China
//              carries just 7 plates from orbit;
//   L2 (mid):  labelTier-2 large cities fade in with their labels;
//   L3 (near): labelTier-3 mid-size cities fade in with their labels;
//   L4 (deep): the China prefecture boundaries + city names in view,
//              ADM2 county boundaries for the focused country;
//   L5 (block): the closest band (dist < 1.24, floor 1.06) — same
//              plates and boundaries at street-block depth, added so
//              small dense countries (Japan's 47 prefectures) finally
//              separate into individually readable, tappable shapes.
//              Plates keep their fixed screen-pixel ink heights here
//              too; the atmosphere halo and the cloud shell step
//              aside below this band (see the render loop).
// There are NO dot markers: the name plates ARE the city layer (the
// field of white dots was removed at the user's request — too ugly).
// What you can read is what you can tap: picking projects every
// gate-open city to screen space and takes the nearest plate centre.
// Nothing is constant-size: every label's world scale is recomputed
// from the live camera distance each frame, and the on-screen size
// SHRINKS as the camera dives (labelShrink) — at max zoom the names
// are finest, so a province full of prefecture plates stays legible.
// That scaling is uniform across country, province, prefecture and
// city plates, and the selection highlight follows the same rule.
// A strict facing fade keeps back-side and limb labels from stacking.
// Administrative divisions come from real datasets, never hand-drawn:
// province/state boundaries for ALL countries from geoBoundaries
// gbOpen ADM1 (lazy asset), county-level boundaries at deep zoom from
// geoBoundaries gbOpen ADM2 for the focused country (China uses the
// finer DataV prefecture set instead). And any tap that hits no plate
// raycasts onto the sphere itself: the exact tapped coordinates go to
// onPointClick, so ANY place on Earth — a village, a steppe, an ocean
// point — can open its live weather (reverse-geocoded server-side).
// The globe does not move on its own by default: auto-rotate is an
// explicit toggle in the header, and flights no longer end in an
// automatic orbit drift.
// What you can read is what you can tap also covers the deep-zoom
// prefecture plates of the focused Chinese province: they come from
// the admin data (not the city library), so picking hit-tests them
// separately and resolves a hit the way the region picker does —
// a unit in the library selects that city, any other unit opens its
// own weather card from the admin centre. (Before this, those plates
// were display-only: at max zoom the user could read 楚雄/红河 and tap
// them to no effect — the "放到最大不能选行政区域" report.)
// The same rule now covers region NAMES worldwide: ADM1 boundaries
// were drawn for every country, but outside China the regions had no
// name plates on the sphere (the user: "把每个地区名字也加进去，我要
// 看地区的信息"). The focused country's ADM1 regions — names and
// representative points straight from the geoBoundaries gbOpen rows
// in assets/regions.ts, the same rows the region picker lists — get
// province-tier plates at province zoom, and a tap on one resolves
// to the identical place the picker's 全球行政区 entry opens
// (gb:<ISO>-<row>), so the card shows that region's live weather.
// Drag rotation is distance-scaled: the angular speed follows the
// camera's height above the surface so the ground tracks the finger
// at every zoom instead of whipping past at deep zoom.
// Dragging is ORBIT-style (edit #27): the goal is a view centre, not
// a free quaternion — horizontal drags sweep longitude along the
// parallel, vertical drags pitch along the meridian (clamped, never
// over a pole), and the goal orientation is always the north-up
// orbit form, so no drag sequence can accumulate roll. (The stage
// compass that rode on this model was removed at the user's word —
// in the orbit model north is up by construction, so it had nothing
// left to correct.)
// On top of the tier gates, every frame runs screen-space collision
// avoidance over the surviving labels: candidates are projected to
// pixels, sorted by priority (label tier, then capitals, active city on
// top) and greedily placed — a lower-priority plate that would overlap
// an already-placed one is hidden for that frame, so dense clusters
// (Beijing/Tianjin, Shanghai/Nanjing/Hangzhou, Guangzhou/Shenzhen,
// Xi'an/Zhengzhou) never smear into an unreadable pile at any zoom.
//
// Performance rules (unchanged): sphere ≤64 segments, pixelRatio capped
// at 2 and stepped down if frames run long, boundaries are single
// LineSegments, label textures are built lazily per tier, no per-frame
// allocation in the render loop, rendering pauses while hidden.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import earthDayUrl from "./assets/earth-day.jpg";
import earthDaySmUrl from "./assets/earth-day-sm.jpg";
import earthTerrainUrl from "./assets/earth-terrain.jpg";
import earthTerrainSmUrl from "./assets/earth-terrain-sm.jpg";
import earthSimpleUrl from "./assets/earth-simple.jpg";
import earthCloudsUrl from "./assets/earth-clouds.png";
import { BORDER_RINGS } from "./assets/borders";
import {
PROVINCES,
CITIES_BY_PROVINCE,
type AdminUnit,
} from "./assets/china-admin";
import { GB_COUNTRIES } from "./assets/gb-countries";
import { CITIES, type City } from "./cities";
import { findTwilightCities, subsolarPoint } from "./solar";

export type GlobeLevel = 1 | 2 | 3 | 4 | 5;

// Basemap layers, Google-style: satellite (real imagery, the default),
// terrain (shaded relief + soft hypsometric tones), simple (the light
// Google-Maps-style schematic: near-white land, pale blue-grey water).
// All three textures are local bundled equirectangular images loaded
// the same direct way as the original day map — no swap-in upgrades,
// no runtime fetches.
export type MapLayer = "satellite" | "terrain" | "simple";

// Chinese display names for ADM1 region plates, keyed by country ISO
// → the geoBoundaries dataset name. The dataset itself ships local /
// English names only, which left the globe mixing English province
// plates with Chinese city plates (the user's 2026-11-18 recording
// over Iran: Ardabil / Gilan / Golestan next to 伊斯法罕). Only
// countries whose names come from a real Chinese source are listed
// — Iran's 31 provinces are taken from the Chinese Wikipedia
// 伊朗省份 list (itself citing 中国地图出版社 / 周定国《世界地名
// 翻译大辞典》), converted to Simplified Chinese, WITHOUT the 省
// suffix (plate style matches the dataset's bare names). Names are
// never coined here: a region with no sourced Chinese name keeps
// its dataset name.
const REGION_ZH_NAMES: Record<string, Record<string, string>> = {
  IRN: {
    "Mazandaran": "马赞德兰",
    "North Khorasan": "北呼罗珊",
    "Kerman": "克尔曼",
    "Ilam": "伊拉姆",
    "Lorestan": "洛雷斯坦",
    "Markazi": "中央",
    "Chaharmahal and Bakhtiari": "恰哈马哈勒—巴赫蒂亚里",
    "Kermanshah": "克尔曼沙汗",
    "Hamadan": "哈马丹",
    "Qazvin": "加兹温",
    "Gilan": "吉兰",
    "Zanjan": "赞詹",
    "Semnan": "塞姆南",
    "Isfahan": "伊斯法罕",
    "Kohgiluyeh and Boyer-Ahmad": "科吉卢耶—博韦艾哈迈德",
    "Kurdistan": "库尔德斯坦",
    "West Azerbaijan": "西亚塞拜然",
    "Fars": "法尔斯",
    "Bushehr": "布什尔",
    "Ardabil": "阿尔达比勒",
    "Golestan": "戈勒斯坦",
    "Razavi Khorasan": "礼萨呼罗珊",
    "South Khorasan": "南呼罗珊",
    "Sistan and Baluchestan": "锡斯坦和俾路支斯坦",
    "Qom": "库姆",
    "Alborz": "厄尔布尔士",
    "East Azerbaijan": "东亚塞拜然",
    "Yazd": "亚兹德",
    "Hormozgan": "霍尔木兹甘",
    "Khuzestan": "胡齐斯坦",
    "Tehran": "德黑兰",
  },
};

// A deep-zoom tap on a prefecture plate that is NOT in the city
// library resolves to this place shape (identical to the region
// picker's SubPlace): the App opens its weather card from the admin
// centre coordinates.
export interface GlobeAdminPlace {
  id: string;
  zh: string;
  en: string;
  country: string;
  region: string;
  lat: number;
  lng: number;
  tz: string; // IANA zone, or "auto" (resolved server-side from coords)
  wiki: string; // Wikipedia article title for the photo lookup
}

// ── v2.0 live-Earth layer data (owned by App, rendered here) ────────
export interface GlobeQuake {
  id: string;
  mag: number;
  depth: number | null;
  place: string;
  time: number;
  lat: number;
  lng: number;
  url: string | null;
}

export interface GlobeEvent {
  id: string;
  title: string;
  category: string; // wildfires | volcanoes | severeStorms | floods
  date: string | null;
  lat: number;
  lng: number;
  link: string | null;
  sourceUrl: string | null;
}

// ── v3.0 layer data: space stations + live flights ──────────────────
// Stations are propagated server-side from CelesTrak TLEs (SGP4);
// `track` is the ±50-minute ground track as [lng, lat] pairs. Flights
// are live ADS-B/OpenSky state vectors aggregated server-side.
export interface GlobeStation {
  id: string; // "iss" | "css"
  name: string;
  lat: number;
  lng: number;
  altKm: number;
  velocityKmh: number;
  track: Array<[number, number]>;
}

export interface GlobeFlight {
  id: string;
  callsign: string | null;
  lat: number;
  lng: number;
  altM: number | null;
  speedKmh: number | null;
  heading: number | null;
  // Vertical rate in m/s from the feed (null when omitted) — the
  // detail card's 爬升率 cell reads it.
  vrateMs: number | null;
  detail: string;
  // Icon class classified server-side, primarily from the ICAO
  // type designator: paper plane for airliners, a sleek swept-wing
  // jet for business jets, a prop plane for piston/turboprop
  // aircraft, a helicopter for rotorcraft.
  kind: "airliner" | "bizjet" | "prop" | "heli";
  // Registration + ICAO type designator when the feed carries them
  // (null on OpenSky-sourced flights) — the detail card's photo
  // lookup keys off these plus the transponder hex in `id`.
  reg: string | null;
  type: string | null;
}

// Live vessels (AIS), the ship layer's mirror of GlobeFlight: the
// server aggregates AIS sources (aisstream.io global stream primary,
// facha.dev hub sweep, Digitraffic fallback) into this shape. `kind` is the icon class
// derived server-side from the AIS ship-type code; `typeLabel` is
// its Chinese label. Destination / ETA are crew-declared free text
// from the transponder — displayed as declared, never parsed into
// facts. Length/beam are derived from the AIS dimension offsets.
export interface GlobeShip {
  id: string; // MMSI
  name: string | null;
  lat: number;
  lng: number;
  sogKn: number | null;
  cog: number | null;
  heading: number | null;
  kind: "cargo" | "tanker" | "passenger" | "fishing" | "other";
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

// One Windy webcam's globe point: id / title / position plus the
// city + country the API reports. The live image is NOT part of the
// layer payload (free-plan image links are short-lived) — App
// resolves it through the getWebcam action when a point is tapped.
export interface GlobeWebcam {
  id: string;
  title: string;
  lat: number;
  lng: number;
  city: string | null;
  country: string | null;
}

// One composed RainViewer frame (equirectangular canvas + a key that
// changes per frame so the overlay effect re-uploads the texture).
export interface GlobeOverlayFrame {
  canvas: HTMLCanvasElement;
  key: number;
}

export interface GlobeFocus {
  id: string;
  lat: number;
  lng: number;
  tier: 1 | 2 | 3;
  nonce: number;
  // Optional resting camera distance — region-picker flights use it to
  // land at the depth where the picked region's boundaries/labels show
  // (a province at L3 depth, a US state just inside the admin_1 band).
  // When absent, the depth follows the city's label tier as before.
  dist?: number;
}

// Camera distance bands: >= L2_AT → L1, >= L3_AT → L2, >= L4_AT → L3,
// >= L5_AT → L4, below → L5 (street-block depth). The floor has
// deepened in steps as the user asked for more zoom: 1.5 → 1.16
// (county depth) → 1.06 (L5: a small, dense country like Japan — 47
// prefectures in a Kanto cluster ~0.3° apart — finally separates:
// at 1.06 the frame is ~2.6° of latitude tall, so Kantō fills most
// of the screen and each prefecture's shape and plate stands clear).
// Three things make 1.06 safe where the old 1.10 atmosphere shell
// forbade it: the atmosphere fresnel now FADES OUT as the camera
// closes below ~1.25 (and is hidden before the camera reaches its
// 1.10 shell, so diving "inside" it never washes the frame); the
// camera near plane shrinks dynamically with altitude (see the
// render loop) so the surface and the plates at r≈1.01–1.03 are
// never clipped at closest approach; and every screen-space size
// formula (plates, collision rects, selection dot) measures from
// the plate's true depth with a floor of 0.02, not the old 0.4 that
// was written when the closest depth was ~0.16. The accepted trade
// (user-approved): the basemap is still one whole-globe texture, so
// L5 is "nearer", not "sharper" — its value is that prefectures
// become recognisable and tappable.
const L2_AT = 2.42;
const L3_AT = 2.02;
const L4_AT = 1.58;
const L5_AT = 1.24;
const MIN_DIST = 1.06;
const MAX_DIST = 4.2;

function levelFor(dist: number): GlobeLevel {
  if (dist >= L2_AT) return 1;
  if (dist >= L3_AT) return 2;
  if (dist >= L4_AT) return 3;
  if (dist >= L5_AT) return 4;
  return 5;
}

// Fade-in gate as the camera closes in: 0 at/above `from`, 1 at/below `to`.
function gate(dist: number, from: number, to: number): number {
  return THREE.MathUtils.clamp((from - dist) / (from - to), 0, 1);
}

// Camera memory (this tab session only): if the host WebView reloads
// the page under memory pressure — most likely exactly at deep zoom,
// the heaviest scene — the camera comes back to where the user left
// it instead of popping out to the global view (the "放大到底自己
// 退出来" complaint). Same pattern as the fullscreen restore marker
// in App.tsx. Best-effort: any parse/shape problem just means the
// default opening view.
const CAM_KEY = "globe-cam-v1";
function loadSavedCam(): { d: number; q: [number, number, number, number] } | null {
  try {
    const raw = sessionStorage.getItem(CAM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { d?: unknown; q?: unknown };
    const d =
      typeof p.d === "number" && Number.isFinite(p.d)
        ? THREE.MathUtils.clamp(p.d, MIN_DIST, MAX_DIST)
        : null;
    const q =
      Array.isArray(p.q) &&
      p.q.length === 4 &&
      p.q.every((v) => typeof v === "number" && Number.isFinite(v))
        ? (p.q as [number, number, number, number])
        : null;
    return d != null && q ? { d, q } : null;
  } catch {
    return null;
  }
}

// Per-tier label gates — a city becomes visible AND tappable when its
// label tier's gate opens. STRICT level discipline (the user's
// Google-Maps rule): a name never appears before its own level —
// tier-2 cities open exactly at the L2 boundary (2.42), tier-3 at
// the L3 boundary (2.02); the old gates (2.62 / 2.18) leaked the
// next level's names into the wider view and cluttered it.
function labelGate(tier: number, dist: number): number {
  if (tier === 1) return 1;
  if (tier === 2) return gate(dist, L2_AT, 2.14);
  return gate(dist, L3_AT, 1.74);
}

// Label height factor per tier (multiplied by camera distance each frame).
// Tiers: 0 = country, 9 = province, 8 = prefecture/county plate,
// 7 = ADM1 region plate (non-China), 1/2/3 = city label tiers. EVERY
// label kind uses the same distance-proportional scaling (see the
// render loop): on-screen size follows dist × K × shrink(dist), so
// names get SMALLER as you zoom deeper instead of ballooning — the
// "放最大名字没变小" fix.
const TIER_LABEL_K: Record<number, number> = {
  0: 3.3,
  9: 2.7,
  8: 2.1,
  7: 1.5,
  1: 1.18,
  2: 1.04,
  3: 0.94,
};

// On-screen shrink as the camera dives: 1.0 at the L1 resting distance
// (2.95), easing to 0.55 at the deepest zoom (MIN_DIST). Combined with
// the dist-proportional world size this keeps plates readable at every
// level while making them visibly finer the closer you get, so dense
// deep-zoom views (a whole province's prefectures) stay legible.
function labelShrink(dist: number): number {
  return (
    0.55 +
    0.45 * THREE.MathUtils.clamp((dist - MIN_DIST) / (2.95 - MIN_DIST), 0, 1)
  );
}

// Target on-screen glyph-ink height (CSS px) per label tier, used by
// plateWorldHeight() in the render loop: name plates are sized from
// each plate's OWN depth so the ink lands at this fixed pixel height
// at every zoom level — the map-style rule (sizes hold, level gates
// decide what appears). v14 sized plates from the camera's distance
// to the ORIGIN while perspective divides by the plate's depth
// (≈ dist − 1); at max zoom that mismatch is ~7×, which is why deep-
// zoom names ballooned to 8–12% of the screen height on device.
const LABEL_INK_PX: Record<number, number> = {
  0: 16, // country
  9: 14, // province / state
  1: 14, // tier-1 city
  7: 13, // ADM1 region plate
  8: 13, // prefecture / county plate
  2: 13, // tier-2 city
  3: 12, // tier-3 city
};

// Major countries labeled on the sphere (name, lat, lng).
const COUNTRY_LABELS: Array<[string, number, number]> = [
  ["中国", 34, 104],
  ["美国", 39, -98],
  ["俄罗斯", 61, 96],
  ["印度", 21.5, 78.5],
  ["巴西", -10, -53],
  ["澳大利亚", -25, 134],
  ["法国", 47, 2.5],
  ["英国", 54, -2],
  ["德国", 51.2, 10.4],
  ["西班牙", 40.3, -3.6],
  ["埃及", 26.8, 30.8],
  ["南非", -29, 24.7],
  ["日本", 37.5, 138.5],
  ["韩国", 37, 128],
  ["加拿大", 57, -102],
  ["墨西哥", 23.6, -102],
  ["阿根廷", -35.4, -64],
  ["沙特阿拉伯", 24.6, 45],
  ["土耳其", 39, 35.2],
  ["伊朗", 32.4, 53.7],
  ["哈萨克斯坦", 48, 67],
  ["印度尼西亚", -2.2, 118],
  ["尼日利亚", 9.1, 8.7],
  ["蒙古", 46.8, 103.8],
];

// Equirectangular convention matching three.js SphereGeometry UVs.
function latLngToVec3(lat: number, lng: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

// ── Orbit drag model (edit #27) ─────────────────────────────────────
// The camera goal is NO LONGER a free quaternion. It is a point on
// the sphere — the view centre (lat, lng) — and the goal orientation
// is always orbitQuat(centre): Qx(centreLat) · Qy(−90 − centreLng),
// the north-up form flights have always used. In that form the
// north pole's world direction is (0, cos·lat, sin·lat): its screen
// x is identically ZERO, so the pole can only tip toward/away from
// the viewer, never sideways — roll is not merely corrected, it is
// unrepresentable. The old model premultiplied world-axis rotations
// onto a free quaternion; measured with three.js, even a PURE
// horizontal drag rolled the pole (pole.x 0 → 0.225 after one 100px
// drag) and a mixed drag sequence ended at pole.x ≈ 0.19 — the
// user's "上下左右总感觉不能矫正". Dragging now moves the centre
// along the sphere's own arc lines: horizontal drag sweeps longitude
// along the parallel, vertical drag pitches along the meridian with
// the centre latitude clamped to ±ORBIT_TILT_MAX so the view can
// never flip over a pole.
const ORBIT_TILT_MAX = 80;
function orbitQuat(lat: number, lng: number): THREE.Quaternion {
  const clampedLat = Math.max(-ORBIT_TILT_MAX, Math.min(ORBIT_TILT_MAX, lat));
  const qx = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (clampedLat * Math.PI) / 180,
  );
  const qy = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    ((-90 - lng) * Math.PI) / 180,
  );
  return qx.multiply(qy);
}

// The view centre (lat/lng) an arbitrary orientation is looking at —
// used once at startup to convert a camera restored from the
// previous (free-quaternion) builds into orbit state, discarding
// whatever roll it had accumulated.
function centreOfQuat(q: THREE.Quaternion): { lat: number; lng: number } {
  const c = new THREE.Vector3(0, 0, 1).applyQuaternion(q.clone().invert());
  const lat =
    90 - (Math.acos(THREE.MathUtils.clamp(c.y, -1, 1)) * 180) / Math.PI;
  let lng = (Math.atan2(c.z, -c.x) * 180) / Math.PI - 180;
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;
  return { lat, lng };
}

function softDotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.85)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── v2.0 marker textures ────────────────────────────────────────────
// Earthquake marker: a filled core with a bright ring, coloured by
// magnitude band. Natural-event marker: a dark disc carrying a
// VECTOR glyph drawn with canvas paths in the category colour
// (edit #29 — the v2.0 build drew emoji text 🔥🌋🌀🌊, which renders
// as inconsistent full-colour clip-art that clashes with the console
// look and varies by platform; the path glyphs are crisp at any
// size and share one colour language with the UI chips).
// Edit #31: the canvases are now 256×256 with the context scaled
// ×2, so the SAME 128-space path drawing below is supersampled 2×
// — the glyphs are vector paths, and at 256 they stay crisp at the
// largest size a marker can reach on a retina phone (the old 128px
// raster smeared when a marker grew on screen during deep zoom).
function quakeTexture(color: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    g.scale(2, 2);
    g.beginPath();
    g.arc(64, 64, 46, 0, Math.PI * 2);
    g.strokeStyle = color;
    g.lineWidth = 10;
    g.globalAlpha = 0.9;
    g.stroke();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(64, 64, 26, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.beginPath();
    g.arc(64, 64, 10, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,0.95)";
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function quakeColor(mag: number): string {
  if (mag >= 7) return "#ff3b30";
  if (mag >= 6) return "#ff7b54";
  if (mag >= 5.5) return "#ffa53a";
  return "#ffd166";
}

const EVENT_RING: Record<string, string> = {
  wildfires: "#ff8a3a",
  volcanoes: "#ff5f56",
  severeStorms: "#4cc3ff",
  floods: "#38b6ff",
};

// Vector glyphs per event category, drawn in the ring colour on the
// dark disc: flame (teardrop + inner flame), volcano (cone + plume),
// storm (spiral), flood (two wave strokes). Fallback: a plain dot.
function drawEventGlyph(
  g: CanvasRenderingContext2D,
  category: string,
  color: string,
) {
  g.fillStyle = color;
  g.strokeStyle = color;
  if (category === "wildfires") {
    g.beginPath();
    g.moveTo(64, 25);
    g.bezierCurveTo(81, 49, 93, 63, 93, 79);
    g.bezierCurveTo(93, 95, 80, 105, 64, 105);
    g.bezierCurveTo(48, 105, 35, 95, 35, 79);
    g.bezierCurveTo(35, 65, 45, 55, 51, 43);
    g.bezierCurveTo(55, 52, 59, 56, 63, 58);
    g.bezierCurveTo(65, 47, 63, 35, 64, 25);
    g.fill();
    g.fillStyle = "rgba(5,12,20,0.85)";
    g.beginPath();
    g.moveTo(64, 66);
    g.bezierCurveTo(72, 76, 76, 82, 76, 89);
    g.bezierCurveTo(76, 97, 70, 101, 64, 101);
    g.bezierCurveTo(58, 101, 52, 97, 52, 89);
    g.bezierCurveTo(52, 81, 58, 74, 64, 66);
    g.fill();
    return;
  }
  if (category === "volcanoes") {
    // Plume: three rising dots.
    for (const [x, y, r] of [
      [64, 40, 6],
      [55, 29, 4.5],
      [74, 27, 5],
    ] as Array<[number, number, number]>) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // Cone.
    g.beginPath();
    g.moveTo(34, 98);
    g.lineTo(52, 58);
    g.lineTo(76, 58);
    g.lineTo(94, 98);
    g.closePath();
    g.fill();
    // Crater cut.
    g.fillStyle = "rgba(5,12,20,0.9)";
    g.beginPath();
    g.ellipse(64, 58, 11, 4, 0, 0, Math.PI * 2);
    g.fill();
    return;
  }
  if (category === "severeStorms") {
    g.lineWidth = 8;
    g.lineCap = "round";
    g.beginPath();
    const turns = Math.PI * 4.8;
    for (let t = 0; t <= turns; t += 0.12) {
      const r = 2.5 + t * 2.85;
      const x = 64 + Math.cos(t + 0.7) * r;
      const y = 64 + Math.sin(t + 0.7) * r;
      if (t === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    return;
  }
  if (category === "floods") {
    g.lineWidth = 7;
    g.lineCap = "round";
    for (const baseY of [54, 78]) {
      g.beginPath();
      for (let x = 34; x <= 94; x += 3) {
        const y = baseY + Math.sin(((x - 34) / 60) * Math.PI * 2.4) * 6.5;
        if (x === 34) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    return;
  }
  g.beginPath();
  g.arc(64, 64, 12, 0, Math.PI * 2);
  g.fill();
}

// Flight icon atlas (edit: per-class glyphs, replacing the v3.0
// white dots the user rejected). One 512×128 canvas, four 128px
// cells drawn as top-down silhouettes pointing UP (north):
//   cell 0 — paper plane (airliners): the folded-dart silhouette.
//   cell 1 — business jet (edit #38): long slender fuselage,
//     strongly swept wings mounted aft, twin rear engine nacelles
//     and a T-tail — the Gulfstream/Global silhouette language.
//   cell 2 — propeller aircraft (edit #38, split from the old
//     "light" cell): straight-wing plane whose nose carries a
//     wide, flat propeller disc (the top-down read of a spinning
//     prop) with a hub dot, so it can never be mistaken for a jet.
//   cell 3 — helicopter: translucent rotor DISC over a teardrop
//     cabin with a tapered tail boom (redrawn edit #37 — the old
//     cross-of-rotor-bars read as a plus sign / dragonfly at sprite
//     size; the disc + teardrop + tail is how a helicopter actually
//     reads from above, the 🚁 shape language the user asked for).
// Each glyph is drawn twice — a soft dark halo pass (contrast over
// bright terrain) under a light body with a translucent core — and
// the Points shader tints per class and rotates each sprite to the
// aircraft's true heading (local north projected to screen space in
// the vertex shader, so orientation stays correct anywhere on the
// globe, not just when the pole happens to be screen-up).
const FLIGHT_KIND_INDEX: Record<GlobeFlight["kind"], number> = {
  airliner: 0,
  bizjet: 1,
  prop: 2,
  heli: 3,
};

function flightIconAtlas(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const glyphs: Array<(x: CanvasRenderingContext2D) => void> = [
      // Paper plane (folded dart), nose up.
      (x) => {
        x.beginPath();
        x.moveTo(64, 6);
        x.lineTo(114, 118);
        x.lineTo(64, 94);
        x.lineTo(14, 118);
        x.closePath();
        x.fill();
        x.save();
        x.globalCompositeOperation = "destination-out";
        x.beginPath();
        x.moveTo(64, 6);
        x.lineTo(64, 94);
        x.lineTo(46, 118);
        x.lineTo(58, 66);
        x.closePath();
        x.fill();
        x.restore();
      },
      // Business jet, top view: long slender fuselage, strongly
      // swept wings mounted aft, twin rear engine nacelles, T-tail.
      (x) => {
        x.beginPath(); // fuselage
        x.moveTo(64, 4);
        x.quadraticCurveTo(71, 26, 70.5, 52);
        x.lineTo(69, 104);
        x.quadraticCurveTo(68.5, 113, 64, 113);
        x.quadraticCurveTo(59.5, 113, 59, 104);
        x.lineTo(57.5, 52);
        x.quadraticCurveTo(57, 26, 64, 4);
        x.fill();
        x.beginPath(); // left swept wing
        x.moveTo(60, 50);
        x.lineTo(13, 92);
        x.lineTo(17, 101);
        x.lineTo(60, 74);
        x.closePath();
        x.fill();
        x.beginPath(); // right swept wing
        x.moveTo(68, 50);
        x.lineTo(115, 92);
        x.lineTo(111, 101);
        x.lineTo(68, 74);
        x.closePath();
        x.fill();
        x.beginPath(); // rear engine nacelles
        x.ellipse(52, 84, 4.5, 9.5, 0, 0, Math.PI * 2);
        x.fill();
        x.beginPath();
        x.ellipse(76, 84, 4.5, 9.5, 0, 0, Math.PI * 2);
        x.fill();
        x.fillRect(41, 105, 46, 8); // T-tail stabilizer bar
      },
      // Propeller aircraft, top view: nose up, straight wing,
      // tailplane, and the propeller drawn as a wide flat disc
      // across the nose (how a spinning prop reads from above)
      // with a solid hub — the feature that says "propeller".
      (x) => {
        x.beginPath(); // fuselage
        x.moveTo(64, 10);
        x.quadraticCurveTo(72, 32, 71, 62);
        x.lineTo(70, 108);
        x.lineTo(58, 108);
        x.lineTo(57, 62);
        x.quadraticCurveTo(56, 32, 64, 10);
        x.fill();
        x.fillRect(8, 54, 112, 12); // straight main wing
        x.fillRect(39, 100, 50, 10); // tailplane
        x.save(); // propeller disc (slightly softer than the body)
        x.globalAlpha *= 0.85;
        x.beginPath();
        x.ellipse(64, 11, 27, 6.5, 0, 0, Math.PI * 2);
        x.fill();
        x.restore();
        x.beginPath(); // propeller hub
        x.arc(64, 11, 4.5, 0, Math.PI * 2);
        x.fill();
      },
      // Helicopter, top view: a translucent rotor disc (the feature
      // that says "helicopter" from above) over a teardrop cabin
      // with a punched-out canopy, a tapered tail boom, tailplane
      // and a tail fin. Disc/rim alphas are RELATIVE (multiplied
      // into the harness pass alpha) so the halo + tint passes keep
      // their relationship.
      (x) => {
        x.save();
        x.globalAlpha *= 0.16; // rotor disc wash
        x.beginPath();
        x.arc(64, 44, 42, 0, Math.PI * 2);
        x.fill();
        x.globalAlpha *= 3.4; // rotor disc rim (~0.55 of pass alpha)
        x.lineWidth = 3.5;
        x.strokeStyle = x.fillStyle;
        x.beginPath();
        x.arc(64, 44, 42, 0, Math.PI * 2);
        x.stroke();
        x.restore();
        x.beginPath(); // tail boom, tapered
        x.moveTo(58.5, 56);
        x.lineTo(69.5, 56);
        x.lineTo(66.5, 110);
        x.lineTo(61.5, 110);
        x.closePath();
        x.fill();
        x.fillRect(46, 100, 36, 7); // tailplane
        x.fillRect(61.5, 106, 5, 12); // tail fin
        x.beginPath(); // cabin teardrop, nose up
        x.moveTo(64, 15);
        x.bezierCurveTo(78, 15, 84.5, 29, 84.5, 45);
        x.bezierCurveTo(84.5, 61, 76.5, 71, 64, 71);
        x.bezierCurveTo(51.5, 71, 43.5, 61, 43.5, 45);
        x.bezierCurveTo(43.5, 29, 50, 15, 64, 15);
        x.fill();
        x.save(); // canopy notch, same cut-out trick as the dart fold
        x.globalCompositeOperation = "destination-out";
        x.beginPath();
        x.ellipse(64, 33, 9, 13, 0, 0, Math.PI * 2);
        x.fill();
        x.restore();
      },
    ];
    glyphs.forEach((draw, i) => {
      g.save();
      g.translate(i * 128, 0);
      g.shadowColor = "rgba(2,10,18,0.9)";
      g.shadowBlur = 7;
      g.fillStyle = "rgba(240,250,255,0.98)";
      draw(g);
      g.shadowBlur = 0;
      g.globalAlpha = 0.35;
      g.fillStyle = "rgba(160,225,255,0.9)";
      draw(g);
      g.restore();
    });
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const SHIP_KIND_INDEX: Record<GlobeShip["kind"], number> = {
  cargo: 0,
  tanker: 1,
  passenger: 2,
  fishing: 3,
  other: 4,
};

// Ship icon atlas: one 640×128 canvas, five 128px cells drawn as
// top-down hull silhouettes pointing UP (bow north), same harness as
// the flight atlas (soft dark halo pass under a light body):
//   cell 0 — cargo: long hull + container-block deck cuts.
//   cell 1 — tanker: long hull + round deck tanks + centre pipeline.
//   cell 2 — passenger: hull + long central superstructure + bridge
//     wings near the bow.
//   cell 3 — fishing: short hull, mast dot, boom lines to the stern.
//   cell 4 — other: plain hull + stern deckhouse.
function shipIconAtlas(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const hull = (x: CanvasRenderingContext2D, w = 15) => {
      x.beginPath();
      x.moveTo(64, 6);
      x.quadraticCurveTo(64 + w, 22, 64 + w, 46);
      x.lineTo(64 + w, 102);
      x.quadraticCurveTo(64 + w, 116, 64 + w - 8, 116);
      x.lineTo(64 - w + 8, 116);
      x.quadraticCurveTo(64 - w, 116, 64 - w, 102);
      x.lineTo(64 - w, 46);
      x.quadraticCurveTo(64 - w, 22, 64, 6);
      x.fill();
    };
    const glyphs: Array<(x: CanvasRenderingContext2D) => void> = [
      // Cargo: hull + container stacks (cut lines between blocks).
      (x) => {
        hull(x);
        x.save();
        x.globalCompositeOperation = "destination-out";
        x.fillRect(49.5, 62, 29, 2.6);
        x.fillRect(49.5, 84, 29, 2.6);
        x.fillRect(62.7, 34, 2.6, 62);
        x.restore();
        x.fillRect(54, 100, 20, 9); // stern deckhouse block
      },
      // Tanker: hull + four round tanks + centre pipeline.
      (x) => {
        hull(x);
        for (const cy of [34, 56, 78, 98]) {
          x.beginPath();
          x.arc(64, cy, 10.5, 0, Math.PI * 2);
          x.fill();
        }
        x.save();
        x.globalCompositeOperation = "destination-out";
        x.fillRect(61.8, 16, 4.4, 100);
        x.restore();
        x.fillRect(57, 14, 14, 7); // stern castle
      },
      // Passenger: hull + superstructure + bridge wings.
      (x) => {
        hull(x, 17);
        x.fillRect(55, 30, 18, 62); // central superstructure
        x.fillRect(45, 24, 38, 8); // bridge wings
        x.beginPath();
        x.arc(64, 104, 6, 0, Math.PI * 2);
        x.fill();
      },
      // Fishing: short hull + mast + boom lines.
      (x) => {
        x.beginPath();
        x.moveTo(64, 24);
        x.quadraticCurveTo(75, 36, 75, 58);
        x.lineTo(73, 98);
        x.quadraticCurveTo(72, 107, 64, 107);
        x.quadraticCurveTo(56, 107, 55, 98);
        x.lineTo(53, 58);
        x.quadraticCurveTo(53, 36, 64, 24);
        x.fill();
        x.lineWidth = 3.4;
        x.strokeStyle = x.fillStyle;
        x.beginPath();
        x.moveTo(64, 54);
        x.lineTo(52, 96);
        x.moveTo(64, 54);
        x.lineTo(76, 96);
        x.stroke();
        x.beginPath();
        x.arc(64, 52, 4.6, 0, Math.PI * 2);
        x.fill();
      },
      // Other: plain hull + stern deckhouse.
      (x) => {
        hull(x, 13);
        x.fillRect(55, 92, 18, 14);
      },
    ];
    glyphs.forEach((draw, i) => {
      g.save();
      g.translate(i * 128, 0);
      g.shadowColor = "rgba(2,10,18,0.9)";
      g.shadowBlur = 7;
      g.fillStyle = "rgba(240,250,255,0.98)";
      draw(g);
      g.shadowBlur = 0;
      g.globalAlpha = 0.35;
      g.fillStyle = "rgba(160,225,255,0.9)";
      draw(g);
      g.restore();
    });
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Points shader for the flight cloud: one draw call, per-point
// class (atlas cell + tint + size) and heading. The vertex stage
// projects the aircraft's heading vector (built from local north /
// east in object space) into screen space so the fragment stage can
// rotate the glyph's sampling window onto the true track.
function flightPointsMaterial(): THREE.ShaderMaterial {
  return iconPointsMaterial(flightIconAtlas(), 4);
}

function shipPointsMaterial(): THREE.ShaderMaterial {
  return iconPointsMaterial(shipIconAtlas(), 5);
}

// Webcam icon atlas: a single 128px cell — a top-down-neutral camera
// glyph (rounded body, viewfinder bump, lens ring with a cut-out
// centre), drawn with the same halo pass as the ship/flight atlases.
// One cell, no heading rotation (a webcam has no course).
function webcamIconAtlas(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const draw = (x: CanvasRenderingContext2D) => {
      // Body.
      x.beginPath();
      x.roundRect(26, 42, 76, 52, 12);
      x.fill();
      // Viewfinder bump.
      x.beginPath();
      x.roundRect(48, 32, 32, 16, 6);
      x.fill();
      // Lens: ring filled, centre + glint cut out.
      x.beginPath();
      x.arc(64, 68, 17, 0, Math.PI * 2);
      x.fill();
      x.save();
      x.globalCompositeOperation = "destination-out";
      x.beginPath();
      x.arc(64, 68, 8.5, 0, Math.PI * 2);
      x.fill();
      x.beginPath();
      x.arc(58, 61, 3, 0, Math.PI * 2);
      x.fill();
      x.restore();
    };
    g.save();
    g.shadowColor = "rgba(2,10,18,0.9)";
    g.shadowBlur = 7;
    g.fillStyle = "rgba(240,250,255,0.98)";
    draw(g);
    g.shadowBlur = 0;
    g.globalAlpha = 0.35;
    g.fillStyle = "rgba(160,225,255,0.9)";
    draw(g);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function webcamPointsMaterial(): THREE.ShaderMaterial {
  return iconPointsMaterial(webcamIconAtlas(), 1);
}

function iconPointsMaterial(
  atlas: THREE.Texture,
  cells: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uCells: { value: cells },
      uPixelRatio: { value: 1 },
      uAspect: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aKind;
      attribute float aHeading; // radians, compass (0 = north, CW)
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPixelRatio;
      uniform float uAspect;
      varying float vKind;
      varying vec3 vColor;
      varying float vRot;
      void main() {
        vKind = aKind;
        vColor = aColor;
        vec3 nrm = normalize(position);
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 north = up - nrm * dot(up, nrm);
        float nl = length(north);
        north = nl > 0.001 ? north / nl : vec3(1.0, 0.0, 0.0);
        vec3 east = normalize(cross(up, nrm));
        vec3 dir = north * cos(aHeading) + east * sin(aHeading);
        vec4 clipC = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 clipH = projectionMatrix * modelViewMatrix * vec4(position + dir * 0.02, 1.0);
        vec2 d = clipH.xy / clipH.w - clipC.xy / clipC.w;
        d.x *= uAspect;
        // Sampling-window rotation that lands the glyph's nose on
        // the projected heading (see aurora.ts-style derivation in
        // the build notes: beta = atan2(dx, dy) in NDC, y-up).
        vRot = atan(d.x, d.y);
        gl_Position = clipC;
        gl_PointSize = aSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uCells;
      varying float vKind;
      varying vec3 vColor;
      varying float vRot;
      void main() {
        vec2 q = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) - 0.5;
        float cb = cos(vRot);
        float sb = sin(vRot);
        vec2 qr = vec2(cb * q.x - sb * q.y, sb * q.x + cb * q.y) + 0.5;
        if (qr.x < 0.0 || qr.x > 1.0 || qr.y < 0.0 || qr.y > 1.0) discard;
        vec2 uv = vec2((vKind + qr.x) / uCells, qr.y);
        vec4 tex = texture2D(uAtlas, uv);
        if (tex.a < 0.03) discard;
        gl_FragColor = vec4(vColor * tex.rgb, tex.a * 0.96);
      }
    `,
  });
}

// Station marker (v3.0): a ringed dot + the station's short label,
// baked on a wide canvas; the render loop sizes the sprite from its
// own depth like every other icon.
function stationTexture(short: string, color: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 96;
  const g = c.getContext("2d");
  if (g) {
    g.beginPath();
    g.arc(48, 48, 26, 0, Math.PI * 2);
    g.fillStyle = "rgba(5,12,20,0.88)";
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = color;
    g.stroke();
    g.beginPath();
    g.arc(48, 48, 9, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.font = "600 40px ui-monospace, Menlo, Consolas, monospace";
    g.textBaseline = "middle";
    g.lineWidth = 8;
    g.strokeStyle = "rgba(3,8,14,0.9)";
    g.strokeText(short, 88, 50);
    g.fillStyle = "#ffffff";
    g.fillText(short, 88, 50);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function eventTexture(category: string): THREE.Texture {
  const ring = EVENT_RING[category] ?? "#ffffff";
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    g.scale(2, 2);
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.fillStyle = "rgba(5,12,20,0.85)";
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = ring;
    g.stroke();
    drawEventGlyph(g, category, ring);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Label materials registry + the tint applied to every plate. On the
// light "simple" basemap the near-white label fills are multiplied by
// a dark slate tint so names read dark-on-light (Google-style); the
// baked dark outline keeps them legible on the photo layers too.
// makeLabel/makeLabels register every material they create here and
// stamp new plates with the current tint, so plates built after a
// layer switch (region / prefecture sets) start out correct.
const labelMats = new Set<THREE.SpriteMaterial>();
let currentLabelTint = 0xffffff;
function applyLabelTint(hex: number) {
  currentLabelTint = hex;
  for (const m of labelMats) m.color.setHex(hex);
}

// ── Unified same-place name matching (dedupe across ALL sources) ────
// Name plates come from independent layers — DataV province plates,
// the city library, geoBoundaries ADM1 region plates — and the same
// place is often named by two of them in different forms: 重庆 the
// province vs 重庆 the city (identical), "Delhi" the region vs
// "New Delhi" the city, "Jakarta Special Capital Region" vs
// "Jakarta". Exact-string equality (the old rule) missed every
// variant form, so pairs survived on the terrain layer's Asia view
// (重庆 / 新德里 / 孟买 area / 新加坡 / 雅加达 reported doubled).
// Matching is therefore done on normalised forms: case/diacritic/
// punctuation-insensitive, generic admin suffixes stripped, and a
// containment test (one normalised name inside the other) with a
// length floor so short unrelated names can't false-match.
const NAME_GENERIC_WORDS = new Set([
  "special", "capital", "region", "province", "state", "district",
  "territory", "municipality", "autonomous", "prefecture", "county",
  "city", "of", "the", "and",
]);
function normNameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function strippedNameKey(s: string): string {
  const words = normNameKey(s)
    .split(" ")
    .filter((w) => w.length > 0 && !NAME_GENERIC_WORDS.has(w));
  return words.join(" ");
}
function nameKeysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = strippedNameKey(a);
  const sb = strippedNameKey(b);
  if (sa && sb) {
    if (sa === sb) return true;
    const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    // Containment: "delhi" inside "new delhi", "jakarta" inside
    // "jakarta special capital region" (stripped: "jakarta").
    // Latin keys need ≥3 chars, CJK keys ≥2 — below that, unrelated
    // short names would collide.
    const minLen = /[a-z]/.test(short) ? 3 : 2;
    if (short.replace(/ /g, "").length >= minLen && long.includes(short)) {
      return true;
    }
  }
  return false;
}
// True when two plates (each with a primary name and an optional
// alternate/English name) name the same place.
function platesNameSamePlace(
  aName: string,
  aAlt: string | null,
  bName: string,
  bAlt: string | null,
): boolean {
  const aKeys = [aName, aAlt].filter((x): x is string => !!x);
  const bKeys = [bName, bAlt].filter((x): x is string => !!x);
  for (const ak of aKeys) {
    for (const bk of bKeys) {
      if (nameKeysMatch(ak, bk)) return true;
    }
  }
  return false;
}
// Same-name capture radius by zoom band: at the wide levels the two
// sources' anchors for one place can sit far apart on screen (a
// province centroid vs its capital city; a region's boundary vertex
// vs the city centre), so the radius is widest at L1 and tightens as
// the camera dives and anchors converge. The old flat 90px only
// caught near-identical anchors — pairs beyond it read as doubles.
function dedupeRadiusPx(dist: number): number {
  if (dist >= 2.42) return 300;
  if (dist >= 2.02) return 230;
  if (dist >= 1.58) return 160;
  if (dist >= 1.24) return 115;
  return 95; // L5: anchors have nearly converged; keep the net tight
}

// Label texture with a canvas sized to the TEXT, not a fixed 384px
// box: the old fixed canvas silently clipped long names at its edges
// ("Jakarta Special Capital Regi…"). The text is measured first; the
// canvas grows to the full string (up to 1080px), and only past that
// does the font shrink to fit — never below ~0.68× the tier's base
// size, so glyphs stay at a readable floor. The plate's aspect ratio
// is per-label now (canvasW / 96), and a screen-space width cap in the
// render loop keeps very long plates from spanning the whole view.
const LABEL_CANVAS_H = 96;
const LABEL_CANVAS_MAX_W = 1080;
function labelTexture(
  text: string,
  opts: { size: number; color: string; weight?: number },
): { tex: THREE.Texture; textW: number; fontPx: number; aspect: number } {
  const measure = document.createElement("canvas").getContext("2d");
  let fontPx = opts.size;
  let rawW = 0;
  if (measure) {
    measure.font = `${opts.weight ?? 500} ${opts.size}px 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;
    rawW = measure.measureText(text).width;
    if (rawW > LABEL_CANVAS_MAX_W - opts.size) {
      const fit = Math.max(
        (LABEL_CANVAS_MAX_W - opts.size) / rawW,
        0.68,
      );
      fontPx = opts.size * fit;
      rawW = rawW * fit;
    }
  }
  const canvasW = Math.max(
    64,
    Math.min(LABEL_CANVAS_MAX_W, Math.ceil(rawW + fontPx * 0.9)),
  );
  const c = document.createElement("canvas");
  c.width = canvasW;
  c.height = LABEL_CANVAS_H;
  const g = c.getContext("2d");
  let textW = rawW;
  if (g) {
    // Regular weight (500, not 600) and a SINGLE fill pass: the old
    // bake (600 weight + 0.17× stroke + double fill + 5px shadow
    // blur) read fine as white-on-photo, but on the light "simple"
    // basemap the dark material tint multiplies fill AND outline
    // toward the same near-black, so every glyph swelled into an
    // unreadable blob (the 华南简图 report: 广州/南宁 strokes fused
    // into black clumps). The thinner bake — stroke 0.09×, shadow
    // blur 2, one fill — keeps satellite/terrain plates readable
    // over snowcaps while simple-layer names stay crisp strokes.
    const weight = opts.weight ?? 500;
    g.font = `${weight} ${fontPx}px 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    textW = Math.min(canvasW, g.measureText(text).width);
    g.lineJoin = "round";
    g.lineWidth = Math.max(3, fontPx * 0.09);
    g.strokeStyle = "rgba(3,10,17,0.82)";
    g.strokeText(text, canvasW / 2, 50);
    g.shadowColor = "rgba(2,8,14,0.7)";
    g.shadowBlur = 2;
    g.fillStyle = opts.color;
    g.fillText(text, canvasW / 2, 50);
    g.shadowBlur = 0;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, textW, fontPx, aspect: canvasW / LABEL_CANVAS_H };
}

// Ink width as a fraction of the label canvas (stroke + a little air
// included), clamped so degenerate measurements can't collapse or
// inflate a plate's collision rect.
function textFracOf(textW: number, fontPx: number, canvasW: number): number {
  return THREE.MathUtils.clamp((textW + fontPx * 0.6) / canvasW, 0.18, 1);
}

// Ink height as a fraction of the label canvas height.
function textHFracOf(fontPx: number): number {
  return THREE.MathUtils.clamp(fontPx / LABEL_CANVAS_H, 0.3, 0.65);
}

// One merged LineSegments from flat [lng, lat, ...] rings.
function buildLineSegments(
  units: Array<{ rings: number[][] }>,
  radius: number,
  color: number,
  opacity: number,
): THREE.LineSegments {
  let segCount = 0;
  for (const u of units)
    for (const ring of u.rings) segCount += Math.max(0, ring.length / 2 - 1);
  const pos = new Float32Array(segCount * 6);
  let o = 0;
  for (const u of units) {
    for (const ring of u.rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const lngA = ring[i * 2] ?? 0;
        const latA = ring[i * 2 + 1] ?? 0;
        const lngB = ring[(i + 1) * 2] ?? 0;
        const latB = ring[(i + 1) * 2 + 1] ?? 0;
        if (Math.abs(lngA - lngB) >= 180) continue;
        const a = latLngToVec3(latA, lngA, radius);
        const b = latLngToVec3(latB, lngB, radius);
        pos[o++] = a.x;
        pos[o++] = a.y;
        pos[o++] = a.z;
        pos[o++] = b.x;
        pos[o++] = b.y;
        pos[o++] = b.z;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
}

// National borders as ONE LineSegments (single draw call). Brightest of
// the three boundary levels: country > province/state > city.
function buildBorders(): THREE.LineSegments {
  return buildLineSegments(
    BORDER_RINGS.map((ring) => ({ rings: [ring] })),
    1.004,
    0xeaf6ff,
    0.36,
  );
}

// ── Selection highlight geometry ─────────────────────────────────────
// The selection marker is the tapped place's own administrative unit,
// filled + outlined from the real dataset geometry (Google-Maps
// style), replacing the old giant white ring-and-needle pin. China
// resolves through the DataV province/prefecture rings (already
// grouped per unit); the rest of the world through the geoBoundaries
// ADM1 units in assets/admin1-units.ts (same source geometry as the
// drawn ADM1 boundaries, grouped by region), lazy-loaded on first use.

function pipRing(lng: number, lat: number, ring: number[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i] ?? 0;
    const yi = ring[i + 1] ?? 0;
    const xj = ring[j] ?? 0;
    const yj = ring[j + 1] ?? 0;
    if (
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// Even-odd containment across a unit's rings (outer rings and holes
// alike — the datasets' flattened ring lists don't distinguish them).
function ringsContain(rings: number[][], lng: number, lat: number): boolean {
  let n = 0;
  for (const r of rings) if (pipRing(lng, lat, r)) n++;
  return n % 2 === 1;
}

// Minimum distance (degrees, longitude scaled by cos(lat)) from a
// point to any segment of a unit's rings — the near-miss fallback for
// points that sit just outside a simplified boundary (dataset
// representative points are boundary vertices of the UNSIMPLIFIED
// geometry, so they can land a hair outside the drawn rings).
function ringsDistance(rings: number[][], lng: number, lat: number): number {
  const kx = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 2; i += 2) {
      const ax = (ring[i] ?? 0) * kx;
      const ay = ring[i + 1] ?? 0;
      const bx = (ring[i + 2] ?? 0) * kx;
      const by = ring[i + 3] ?? 0;
      if (Math.abs((ring[i] ?? 0) - (ring[i + 2] ?? 0)) > 180) continue;
      const px = lng * kx;
      const py = lat;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 > 0
          ? THREE.MathUtils.clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
          : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

// Subdivide a [lng, lat, ...] ring into points no more than ~1.2°
// apart so the filled surface hugs the sphere along the boundary.
function subdivideRing(ring: number[]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const a: [number, number] = [ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0];
    const b: [number, number] = [
      ring[((i + 1) % n) * 2] ?? 0,
      ring[((i + 1) % n) * 2 + 1] ?? 0,
    ];
    pts.push(a);
    if (Math.abs(a[0] - b[0]) > 180) continue; // antimeridian jump
    const steps = Math.floor(
      Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.2,
    );
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return pts;
}

// Fill geometry for one unit's rings: gnomonic projection onto the
// tangent plane at the unit's centroid, earcut triangulation via
// THREE.ShapeUtils (holes classified by containment, islands become
// their own polygons), vertices lifted back onto the sphere at
// r=1.0115 — every vertex sits exactly on its real boundary point.
function buildHighlightGeometry(rings: number[][]): THREE.BufferGeometry | null {
  const ringPts = rings
    .map(subdivideRing)
    .filter((p) => p.length >= 3);
  if (ringPts.length === 0) return null;
  // Centre = mean direction of the largest ring.
  let largest = ringPts[0] as Array<[number, number]>;
  for (const p of ringPts) if (p.length > largest.length) largest = p;
  const centre = new THREE.Vector3();
  for (const [lng, lat] of largest) {
    centre.add(latLngToVec3(lat, lng, 1));
  }
  if (centre.lengthSq() < 1e-6) return null;
  centre.normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(centre);
  if (east.lengthSq() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = centre.clone().cross(east).normalize();
  const project = (lng: number, lat: number): THREE.Vector2 => {
    const p = latLngToVec3(lat, lng, 1);
    const d = Math.max(0.05, p.dot(centre));
    return new THREE.Vector2(p.dot(east) / d, p.dot(north) / d);
  };
  // Group rings into polygons (contour + holes) by 2D containment.
  interface Poly {
    contour: THREE.Vector2[];
    contourLL: Array<[number, number]>;
    holes: THREE.Vector2[][];
  }
  const sorted = [...ringPts].sort((a, b) => {
    const area = (pts: Array<[number, number]>) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i] as [number, number];
        const q = pts[(i + 1) % pts.length] as [number, number];
        s += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(s);
    };
    return area(b) - area(a);
  });
  const polys: Poly[] = [];
  for (const pts of sorted) {
    const first = pts[0] as [number, number];
    let host: Poly | null = null;
    for (const poly of polys) {
      const hostFlat = poly.contourLL.flatMap(([x, y]) => [x, y]);
      if (pipRing(first[0], first[1], hostFlat)) {
        host = poly;
        break;
      }
    }
    const projected = pts.map(([lng, lat]) => project(lng, lat));
    if (host) {
      host.holes.push(projected);
    } else {
      polys.push({ contour: projected, contourLL: pts, holes: [] });
    }
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const tmp = new THREE.Vector3();
  for (const poly of polys) {
    const all = [...poly.contour, ...poly.holes.flat()];
    if (poly.contour.length < 3) continue;
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(
        poly.contour,
        poly.holes,
      ) as number[][];
    } catch {
      continue;
    }
    const base = positions.length / 3;
    for (const v of all) {
      tmp
        .copy(centre)
        .addScaledVector(east, v.x)
        .addScaledVector(north, v.y)
        .normalize()
        .multiplyScalar(1.0115);
      positions.push(tmp.x, tmp.y, tmp.z);
    }
    for (const f of faces) {
      indices.push(base + (f[0] ?? 0), base + (f[1] ?? 0), base + (f[2] ?? 0));
    }
  }
  if (indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geo.setIndex(indices);
  return geo;
}

// The highlight display group: translucent fill + bright outline of
// the unit's real boundary rings.
function buildHighlightDisplay(rings: number[][]): THREE.Group | null {
  const geo = buildHighlightGeometry(rings);
  if (!geo) return null;
  const g = new THREE.Group();
  const fill = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: 0x2fb9ec,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  fill.renderOrder = 1;
  g.add(fill);
  const outline = buildLineSegments([{ rings }], 1.0135, 0x8fd8ff, 0.95);
  outline.renderOrder = 3;
  g.add(outline);
  return g;
}

// Lazy loader for the grouped ADM1 units asset (only the selection
// highlight needs per-region geometry).
let adm1UnitsModule: typeof import("./assets/admin1-units") | null = null;
let adm1UnitsPromise: Promise<typeof import("./assets/admin1-units") | null> | null =
  null;
function loadAdm1Units(): Promise<typeof import("./assets/admin1-units") | null> {
  if (adm1UnitsModule) return Promise.resolve(adm1UnitsModule);
  if (!adm1UnitsPromise) {
    adm1UnitsPromise = import("./assets/admin1-units")
      .then((m) => {
        adm1UnitsModule = m;
        return m;
      })
      .catch(() => null);
  }
  return adm1UnitsPromise;
}

// Resolve the administrative unit containing (lat, lng) to its real
// boundary rings: China prefecture → China province → geoBoundaries
// ADM1 unit; near-miss points (just outside a simplified ring) fall
// back to the nearest unit within 0.8°. Null when nothing plausible
// contains the point (open ocean) — the caller then shows a small dot.
async function resolveHighlightRings(
  lat: number,
  lng: number,
): Promise<number[][] | null> {
  interface Cand {
    rings: number[][];
    dist: number;
  }
  let nearest: Cand | null = null;
  const consider = (rings: number[][]) => {
    const d = ringsDistance(rings, lng, lat);
    if (d < (nearest?.dist ?? Infinity)) nearest = { rings, dist: d };
  };
  // China first (DataV set, finer than geoBoundaries for China).
  if (lng >= 70 && lng <= 140 && lat >= 14 && lat <= 56) {
    for (const p of PROVINCES) {
      if (ringsContain(p.rings, lng, lat)) {
        const units = CITIES_BY_PROVINCE[p.name];
        if (units) {
          for (const u of units) {
            if (ringsContain(u.rings, lng, lat)) return u.rings;
          }
        }
        return p.rings;
      }
    }
    for (const p of PROVINCES) consider(p.rings);
    if (nearest && (nearest as Cand).dist < 0.8) {
      return (nearest as Cand).rings;
    }
    nearest = null;
  }
  // geoBoundaries ADM1: only countries whose bbox contains the point
  // are decoded (narrow bboxes first; antimeridian-spanning ones last).
  const cands = GB_COUNTRIES.filter((c) => {
    const [mnx, mny, mxx, mxy] = c.bbox;
    return c.iso !== "CHN" && lng >= mnx && lng <= mxx && lat >= mny && lat <= mxy;
  }).sort((a, b) => {
    const spanA = a.bbox[2] - a.bbox[0] > 180 ? 1 : 0;
    const spanB = b.bbox[2] - b.bbox[0] > 180 ? 1 : 0;
    if (spanA !== spanB) return spanA - spanB;
    return (
      (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) -
      (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])
    );
  });
  if (cands.length > 0) {
    const mod = await loadAdm1Units();
    if (mod) {
      for (const c of cands) {
        const units = mod.getAdm1Units(c.iso);
        if (!units) continue;
        for (const u of units) {
          if (ringsContain(u.rings, lng, lat)) return u.rings;
        }
        for (const u of units) consider(u.rings);
      }
    }
  }
  if (nearest && (nearest as Cand).dist < 0.8) return (nearest as Cand).rings;
  return null;
}

interface LabelRec {
  sprite: THREE.Sprite;
  dir: THREE.Vector3;
  mat: THREE.SpriteMaterial;
  tier: number; // 0 = country, 9 = province, otherwise the city LABEL tier
  aspect: number;
  // The plate's name — plus, for city plates, the English name — used
  // by the same-name dedupe in placement: two layers often name the
  // same place (DataV province plate 北京 vs the Beijing city plate,
  // a "Singapore" region plate vs the Singapore city plate), and the
  // pair must collapse to the higher-priority one within ~90px.
  name: string;
  altName: string | null;
  // Fraction of the sprite's width the name's ink actually occupies
  // (the canvas is a fixed 4:1; short names are mostly margin).
  // Collision rects use ink width, not canvas width.
  textFrac: number;
  // Same for height: the glyphs occupy ~size/96 of the canvas height.
  textHFrac: number;
  // Collision-avoidance priority (higher wins screen space) and, for city
  // plates, the owning city id (the active/hovered city is boosted live).
  priority: number;
  cityId: string | null;
  radius: number;
}

function makeLabels(
  items: Array<{ name: string; altName?: string; lat: number; lng: number; priority: number; cityId?: string }>,
  opts: { size: number; color: string; scale: number; radius: number; tier: number },
): LabelRec[] {
  return items.map((it) => {
    const { tex, textW, fontPx, aspect } = labelTexture(it.name, { size: opts.size, color: opts.color });
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    mat.color.setHex(currentLabelTint);
    labelMats.add(mat);
    const sprite = new THREE.Sprite(mat);
    const p = latLngToVec3(it.lat, it.lng, opts.radius);
    sprite.position.copy(p);
    sprite.scale.set((opts.scale / 4) * aspect, opts.scale / 4, 1);
    // Plates draw on top of the boundary lines and the selection
    // highlight (renderOrder 5) so nothing can wash out the name text.
    sprite.renderOrder = 5;
    return {
      sprite,
      dir: p.clone().normalize(),
      mat,
      tier: opts.tier,
      aspect,
      name: it.name,
      altName: it.altName ?? null,
      textFrac: textFracOf(textW, fontPx, aspect * LABEL_CANVAS_H),
      textHFrac: textHFracOf(fontPx),
      priority: it.priority,
      cityId: it.cityId ?? null,
      radius: opts.radius,
    };
  });
}

// Single-label variant of makeLabels — the chunked label builder creates
// one plate per job so a whole tier never lands in a single frame.
function makeLabel(
  item: { name: string; altName?: string; lat: number; lng: number; priority: number; cityId?: string },
  opts: { size: number; color: string; scale: number; radius: number; tier: number },
): LabelRec {
  const { tex, textW, fontPx, aspect } = labelTexture(item.name, { size: opts.size, color: opts.color });
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  mat.color.setHex(currentLabelTint);
  labelMats.add(mat);
  const sprite = new THREE.Sprite(mat);
  const p = latLngToVec3(item.lat, item.lng, opts.radius);
  sprite.position.copy(p);
  sprite.scale.set((opts.scale / 4) * aspect, opts.scale / 4, 1);
  sprite.renderOrder = 5;
  return {
    sprite,
    dir: p.clone().normalize(),
    mat,
    tier: opts.tier,
    aspect,
    name: item.name,
    altName: item.altName ?? null,
    textFrac: textFracOf(textW, fontPx, aspect * LABEL_CANVAS_H),
    textHFrac: textHFracOf(fontPx),
    priority: item.priority,
    cityId: item.cityId ?? null,
    radius: opts.radius,
  };
}

// Collision candidate, pooled across frames (no per-frame allocation).
interface LabelCand {
  rec: LabelRec;
  op: number;
  x: number;
  y: number;
  hw: number; // half width in px, padding included
  hh: number; // half height in px, padding included
  prio: number;
}

// A city is just its data + facing direction now: no dot sprite (the
// white-dot field was removed), the name plate is its only marker.
interface CityRec {
  city: City;
  dir: THREE.Vector3;
}

export function Globe({
  activeId,
  focus,
  autoRotate,
  layer,
  immersive = false,
  quakes = [],
  events = [],
  showQuakes = false,
  showEvents = false,
  showWeather = true,
  twilightOn = false,
  radarFrame = null,
  cloudFrame = null,
  cloudOn = false,
  auroraFrame = null,
  auroraOn = false,
  stations = [],
  showStations = false,
  flights = [],
  showFlights = false,
  ships = [],
  showShips = false,
  webcams = [],
  showWebcams = false,
  timeShiftMin = 0,
  onCityClick,
  onAdminClick,
  onPointClick,
  onQuakeClick,
  onEventClick,
  onStationClick,
  onFlightClick,
  onShipClick,
  onWebcamClick,
  onLevelChange,
  onInteract,
  onFirstFrame,
  onLoadProgress,
}: {
  activeId: string | null;
  focus: GlobeFocus | null;
  autoRotate: boolean;
  // v2.0 live-Earth layers (data owned + fetched by App; every layer
  // is independently toggleable and degrades silently when its data
  // is absent).
  quakes?: GlobeQuake[];
  events?: GlobeEvent[];
  showQuakes?: boolean;
  showEvents?: boolean;
  showWeather?: boolean;
  twilightOn?: boolean;
  radarFrame?: GlobeOverlayFrame | null;
  cloudFrame?: GlobeOverlayFrame | null;
  cloudOn?: boolean;
  // v3.0: NOAA OVATION aurora field (composed canvas, like the other
  // overlays), space stations + live flights, and the time-machine
  // shift (minutes; drives the terminator/twilight band's sun).
  auroraFrame?: GlobeOverlayFrame | null;
  auroraOn?: boolean;
  stations?: GlobeStation[];
  showStations?: boolean;
  flights?: GlobeFlight[];
  showFlights?: boolean;
  ships?: GlobeShip[];
  showShips?: boolean;
  webcams?: GlobeWebcam[];
  showWebcams?: boolean;
  timeShiftMin?: number;
  onQuakeClick?: (q: GlobeQuake) => void;
  onEventClick?: (e: GlobeEvent) => void;
  onStationClick?: (s: GlobeStation) => void;
  onFlightClick?: (f: GlobeFlight) => void;
  onShipClick?: (s: GlobeShip) => void;
  onWebcamClick?: (w: GlobeWebcam) => void;
  // Active basemap layer (satellite default), chosen in App and
  // persisted there; the globe only applies it.
  layer: MapLayer;
  // True whenever the page is in any fullscreen presentation — native
  // Fullscreen API or the immersive fallback. The renderer applies its
  // fullscreen performance profile (pixel-ratio cap, paused clouds) for
  // both; previously it only recognized the native element state, so
  // the fallback mode ran at full cost on phone GPUs.
  immersive?: boolean;
  onCityClick: (id: string) => void;
  // Deep-zoom tap on a prefecture plate outside the city library.
  onAdminClick?: (place: GlobeAdminPlace) => void;
  // Tap on the sphere itself (no plate hit): the exact coordinates.
  onPointClick?: (lat: number, lng: number) => void;
  onLevelChange: (level: GlobeLevel) => void;
  onInteract: () => void;
  // Fired once after the first successful render — App uses it to
  // lift its bounded loading veil (a reload must always land on the
  // rendered globe, never on an indefinite spinner).
  onFirstFrame?: () => void;
  // Texture-load progress (0..1 across the assets the shared
  // LoadingManager has seen) — App feeds it to the slow-load
  // progress bar that appears when the veil stays up past 5s.
  onLoadProgress?: (frac: number) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  // WebGL context state: Android fullscreen transitions can revoke the
  // GL context (white/blank canvas that never redraws). We surface it,
  // try an automatic restore, and offer a full scene rebuild as the
  // last-resort recovery. mountKey re-runs the init effect for that.
  const [ctxLost, setCtxLost] = useState(false);
  const [mountKey, setMountKey] = useState(0);

  const cityRecsRef = useRef<CityRec[]>([]);
  const cityLabelsRef = useRef<Map<number, LabelRec[]>>(new Map());
  const builtLabelTiersRef = useRef<Set<number>>(new Set());
  // Selection display: the highlighted admin unit (fill + outline
  // group, added to the rotating globe group) and the small fallback
  // dot used only when the tapped point resolves to no admin unit.
  const highlightGroupRef = useRef<THREE.Group | null>(null);
  const selDotRef = useRef<THREE.Sprite | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  // Camera goal state, restored from this session's saved camera
  // when one exists (see loadSavedCam): a page reload at deep zoom
  // lands back at the same depth and heading, not the global view.
  const [savedCam] = useState(loadSavedCam);
  // Orbit state (edit #27): the goal view centre. A camera restored
  // from a previous build's free quaternion is converted through
  // centreOfQuat — its centre survives, its accumulated roll does
  // not. goalQuatRef below is a DERIVED cache: every writer goes
  // through syncGoalFromOrbit, so the goal is always the north-up
  // orbitQuat(centre) and roll stays unrepresentable.
  const goalOrbitRef = useRef<{ lat: number; lng: number }>(
    savedCam
      ? centreOfQuat(new THREE.Quaternion(...savedCam.q).normalize())
      : { lat: 28, lng: 112 },
  );
  const goalQuatRef = useRef<THREE.Quaternion>(
    orbitQuat(goalOrbitRef.current.lat, goalOrbitRef.current.lng),
  );
  const syncGoalFromOrbit = () => {
    goalQuatRef.current.copy(
      orbitQuat(goalOrbitRef.current.lat, goalOrbitRef.current.lng),
    );
  };
  const goalDistRef = useRef(savedCam?.d ?? 2.95);
  // Last focus request, kept so the selection highlight can be
  // resolved for places that have no city record (region-picker
  // provinces, US counties — they exist as coordinates, not as globe
  // markers).
  const lastFocusRef = useRef<GlobeFocus | null>(null);
  const currentDistRef = useRef(savedCam?.d ?? 2.95);
  // Throttled writer for the camera memory above: the render loop
  // calls it every frame; it persists at most every 1.5s, plus a
  // forced write when the page is about to unload or hide.
  const lastCamSaveRef = useRef(0);
  const saveCam = (force = false) => {
    const now = performance.now();
    if (!force && now - lastCamSaveRef.current < 1500) return;
    lastCamSaveRef.current = now;
    try {
      const q = goalQuatRef.current;
      sessionStorage.setItem(
        CAM_KEY,
        JSON.stringify({ d: goalDistRef.current, q: [q.x, q.y, q.z, q.w] }),
      );
    } catch {
      // Storage unavailable (private mode, quota): camera memory is
      // best-effort, the live refs still carry the state.
    }
  };
  useEffect(() => {
    const onLeaving = () => saveCam(true);
    window.addEventListener("beforeunload", onLeaving);
    document.addEventListener("visibilitychange", onLeaving);
    return () => {
      window.removeEventListener("beforeunload", onLeaving);
      document.removeEventListener("visibilitychange", onLeaving);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lastFocusAtRef = useRef(0);
  const hoverIdRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const autoRotateRef = useRef(autoRotate);
  const levelRef = useRef<GlobeLevel>(1);
  const callbacksRef = useRef({ onCityClick, onAdminClick, onPointClick, onQuakeClick, onEventClick, onStationClick, onFlightClick, onShipClick, onWebcamClick, onLevelChange, onInteract, onFirstFrame, onLoadProgress });
  callbacksRef.current = { onCityClick, onAdminClick, onPointClick, onQuakeClick, onEventClick, onStationClick, onFlightClick, onShipClick, onWebcamClick, onLevelChange, onInteract, onFirstFrame, onLoadProgress };
  activeIdRef.current = activeId;
  autoRotateRef.current = autoRotate;
  const layerRef = useRef<MapLayer>(layer);
  layerRef.current = layer;
  const provinceLinesMatRef = useRef<THREE.LineBasicMaterial | null>(null);
  const cloudsRef = useRef<THREE.Mesh | null>(null);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  // The init effect installs its fullscreen-performance sync here so
  // the immersive prop effect below can re-apply the caps on toggle.
  const fsSyncRef = useRef<(() => void) | null>(null);

  // Immersive mode toggled → re-apply the fullscreen performance
  // profile (and re-measure: the fallback resizes the stage).
  useEffect(() => {
    fsSyncRef.current?.();
  }, [immersive, mountKey]);

  const provinceLabelsRef = useRef<LabelRec[]>([]);
  // ── v2.0 layer refs ──────────────────────────────────────────────
  // Groups/meshes are created inside the init effect and stored here;
  // the layer effects below (re)build their contents from props.
  const quakeGroupRef = useRef<THREE.Group | null>(null);
  const eventGroupRef = useRef<THREE.Group | null>(null);
  const twilightMeshRef = useRef<THREE.Mesh | null>(null);
  const twilightUniformRef = useRef<{ value: THREE.Vector3 } | null>(null);
  // Library cities currently inside the twilight band (ids), kept by
  // the render loop on a 20s tick while the band is on (edit #32
  // follow-up): drives the band plates' zoom-gate bypass, warm tint
  // and pick exception, so the mid/large cities at sunset are
  // readable — and tappable — from any zoom.
  const bandCitySetRef = useRef<Set<string> | null>(null);
  const bandCitySetAtRef = useRef(0);
  const radarMeshRef = useRef<THREE.Mesh | null>(null);
  const cloudMeshRef = useRef<THREE.Mesh | null>(null);
  // ── v3.0 layer refs ──────────────────────────────────────────────
  const auroraMeshRef = useRef<THREE.Mesh | null>(null);
  const stationGroupRef = useRef<THREE.Group | null>(null);
  const flightPointsRef = useRef<THREE.Points | null>(null);
  const stationSpritesRef = useRef<
    Array<{ sprite: THREE.Sprite; px: number }>
  >([]);
  const stationPicksRef = useRef<
    Array<{ s: GlobeStation; dir: THREE.Vector3 }>
  >([]);
  const flightPicksRef = useRef<
    Array<{ f: GlobeFlight; dir: THREE.Vector3 }>
  >([]);
  const shipPointsRef = useRef<THREE.Points | null>(null);
  const shipPicksRef = useRef<
    Array<{ s: GlobeShip; dir: THREE.Vector3 }>
  >([]);
  const webcamPointsRef = useRef<THREE.Points | null>(null);
  const webcamPicksRef = useRef<
    Array<{ w: GlobeWebcam; dir: THREE.Vector3 }>
  >([]);
  const showStationsRef = useRef(showStations);
  showStationsRef.current = showStations;
  const showFlightsRef = useRef(showFlights);
  showFlightsRef.current = showFlights;
  const showShipsRef = useRef(showShips);
  showShipsRef.current = showShips;
  const showWebcamsRef = useRef(showWebcams);
  showWebcamsRef.current = showWebcams;
  const timeShiftRef = useRef(timeShiftMin);
  timeShiftRef.current = timeShiftMin;
  // Sprites the render loop scales + pulses (earthquakes): `px` is
  // the sprite's target on-screen diameter in CSS pixels at shrink 1
  // — the loop converts it to a world size from the sprite's own
  // depth every frame (edit #31: fixed world sizes ballooned on
  // screen as the camera dived, the user's 「图标没有跟随变小」).
  const quakeSpritesRef = useRef<
    Array<{ sprite: THREE.Sprite; px: number; phase: number }>
  >([]);
  // Natural-event sprites (wildfire / volcano / storm / flood), same
  // per-frame depth sizing; `px` is the target screen diameter.
  const eventSpritesRef = useRef<Array<{ sprite: THREE.Sprite; px: number }>>(
    [],
  );
  // Pick targets for the event layers, kept in lockstep with the
  // sprites by the layer effects.
  const quakePicksRef = useRef<Array<{ q: GlobeQuake; dir: THREE.Vector3 }>>([]);
  const eventPicksRef = useRef<Array<{ e: GlobeEvent; dir: THREE.Vector3 }>>([]);
  // Prop mirrors read by the init effect's loop / picking.
  const showQuakesRef = useRef(showQuakes);
  showQuakesRef.current = showQuakes;
  const showEventsRef = useRef(showEvents);
  showEventsRef.current = showEvents;
  const showWeatherRef = useRef(showWeather);
  showWeatherRef.current = showWeather;
  const twilightOnRef = useRef(twilightOn);
  twilightOnRef.current = twilightOn;

  // Init scene once per mountKey (a context-loss rebuild bumps the key
  // and re-runs this from scratch, so per-scene refs start clean).
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    cityRecsRef.current = [];
    cityLabelsRef.current = new Map();
    builtLabelTiersRef.current = new Set();
    highlightGroupRef.current = null;
    selDotRef.current = null;
    markersGroupRef.current = null;
    groupRef.current = null;
    provinceLabelsRef.current = [];
    provinceLinesMatRef.current = null;
    cloudsRef.current = null;
    quakeGroupRef.current = null;
    eventGroupRef.current = null;
    twilightMeshRef.current = null;
    twilightUniformRef.current = null;
    radarMeshRef.current = null;
    cloudMeshRef.current = null;
    auroraMeshRef.current = null;
    stationGroupRef.current = null;
    flightPointsRef.current = null;
    shipPointsRef.current = null;
    webcamPointsRef.current = null;
    stationSpritesRef.current = [];
    stationPicksRef.current = [];
    flightPicksRef.current = [];
    shipPicksRef.current = [];
    webcamPicksRef.current = [];
    quakeSpritesRef.current = [];
    levelRef.current = levelFor(currentDistRef.current);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    const maxPR = Math.min(window.devicePixelRatio || 1, 2);
    // Fullscreen pixel-ratio cap (≤1.75) applies from the very first
    // frame when the page (re)opens already in a fullscreen
    // presentation — e.g. the immersive-restore reload — not only
    // once syncFsPerf runs: the entry frame is exactly where the
    // memory spike must not happen. (The cap was 1.5 until the
    // satellite-sharpness round: on a DPR-3 phone that left the
    // canvas at barely half the screen's physical resolution in
    // fullscreen, upscaling everything soft. 1.75 recovers most of
    // the sharpness; the adaptive ladder below still steps down if
    // frames run long.)
    let pixelRatio = immersiveRef.current ? Math.min(maxPR, 1.75) : maxPR;
    renderer.setPixelRatio(pixelRatio);
    // ACES filmic grading: rich Google-Earth-like terrain tones.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    mount.appendChild(renderer.domElement);
    // Pull-to-refresh kill switch for the gesture surface itself:
    // touch-action: none on the mount (not just the canvas) plus a
    // non-passive touchmove preventDefault, so a drag or pinch that
    // starts on the globe can never be reinterpreted by the host
    // WebView as a scroll / pull-to-refresh (which reloaded the page
    // mid-drag on the user's phone). Pointer events are unaffected —
    // the drag/pinch handlers below keep receiving them; only the
    // browser's own gesture handling is cancelled.
    mount.style.touchAction = "none";
    const blockTouchScroll = (e: TouchEvent) => {
      e.preventDefault();
    };
    mount.addEventListener("touchmove", blockTouchScroll, {
      passive: false,
    });

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#000000");
    // Near plane starts at 0.05 and shrinks dynamically with
    // altitude in the render loop: at the L5 floor (dist 1.06) the
    // surface is only 0.06 away and the name plates ride at
    // r≈1.01–1.03, so the old fixed 0.1 near plane would clip the
    // centre of the frame away entirely.
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 300);
    camera.position.set(0, 0, goalDistRef.current);

    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(5, 2.5, 3.5);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xbdd3e6, 0.85));

    const group = new THREE.Group();
    group.quaternion.copy(goalQuatRef.current);
    scene.add(group);
    groupRef.current = group;

    // Hi-res gate by PHYSICAL pixels, not CSS width: the old rule
    // (CSS width ≥1024 AND DPR >1.2) never fired on phones — a
    // Galaxy S24 is 360 CSS px wide — so every phone rendered the
    // 2048px "-sm" basemap upscaled into a 1080px-wide canvas and
    // the satellite layer read blurred at global view (the user's
    // 「底图糊」). Physical width ≥1000 (any modern high-DPR phone,
    // any desktop) now takes the full 4096 assets; genuinely small
    // or low-DPR screens keep the 2048 tier. Single residency
    // (below) bounds the GPU cost to one basemap at a time.
    const useHiRes =
      window.innerWidth * (window.devicePixelRatio || 1) >= 1000;
    // ── Basemap texture residency: ONE layer resident at a time ──
    // Before this round all three 4096/2048 basemaps loaded up-front
    // and stayed resident for the page's life (~48MB of GPU texture
    // for the two 4096 layers alone, plus the fullscreen canvas
    // growing at entry) — the memory spike at fullscreen entry is
    // the most plausible page-side trigger for the host webview
    // reloading the page twice in the first seconds of fullscreen
    // (the host's reason can't be proven from inside the page;
    // shedding resident weight is the only lever the page has).
    // Now: only the ACTIVE layer's texture exists. A layer switch
    // loads the target through the same direct TextureLoader path,
    // swaps the material the frame it is ready, and DISPOSES the
    // previous texture at the swap — steady-state residency is one
    // basemap. Screens under the hi-res gate (see useHiRes above)
    // are capped at the 2048-wide assets for every layer (satellite
    // already had its -sm; terrain gains earth-terrain-sm.jpg;
    // simple is natively 2048); hi-res screens keep the full 4096
    // assets unchanged.
    const layerUrls: Record<MapLayer, string> = {
      satellite: useHiRes ? earthDayUrl : earthDaySmUrl,
      terrain: useHiRes ? earthTerrainUrl : earthTerrainSmUrl,
      simple: earthSimpleUrl,
    };
    interface LayerTexEntry {
      layer: MapLayer;
      tex: THREE.Texture;
      ready: boolean;
    }
    // One LoadingManager for every texture this scene fetches: its
    // aggregate progress is the honest signal behind App's slow-load
    // progress bar (shown when the veil is still up after 5s). The
    // manager counts items cumulatively, so App only consumes the
    // reports until the first frame lands.
    const loadManager = new THREE.LoadingManager();
    loadManager.onProgress = (_url, loaded, total) => {
      if (total > 0) callbacksRef.current.onLoadProgress?.(loaded / total);
    };
    loadManager.onLoad = () => callbacksRef.current.onLoadProgress?.(1);
    const texLoader = new THREE.TextureLoader(loadManager);
    let earthTexEntry: LayerTexEntry | null = null;
    const loadLayerTex = (layer: MapLayer): LayerTexEntry => {
      const entry: LayerTexEntry = {
        layer,
        ready: false,
        tex: null as unknown as THREE.Texture,
      };
      entry.tex = texLoader.load(layerUrls[layer], () => {
        entry.ready = true;
      });
      entry.tex.colorSpace = THREE.SRGBColorSpace;
      // Anisotropy at the hardware max (≤16): on a sphere most of
      // the visible texture is foreshortened toward the limb, and
      // the old fixed 8 left the satellite basemap's land detail
      // smeared exactly where the globe curves away.
      entry.tex.anisotropy = Math.min(
        16,
        renderer.capabilities.getMaxAnisotropy(),
      );
      return entry;
    };
    // The first texture is the layer the page actually opens on
    // (App restores the persisted choice) — not always satellite.
    earthTexEntry = loadLayerTex(layerRef.current);
    const tex = earthTexEntry.tex;
    // No saturation/contrast shader boost: the grading lives in the
    // texture assets themselves (build-time colour work, see
    // DATA-PLAN edit #20) — the satellite asset is a re-graded Blue
    // Marble whose oceans were re-ramped to one uniform deep blue
    // (the raw image's teal shelf patches read as mould on the
    // phone) and whose land saturation was restored; the terrain
    // asset is a hypsometric + hillshade rebuild, not a darkened
    // satellite photo. What reaches the material is final colour.
    const earthMat = new THREE.MeshPhongMaterial({
      map: tex,
      shininess: 8,
      specular: new THREE.Color(0x1a2a38),
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), earthMat);
    group.add(earth);

    // Drifting-cloud texture (351KB PNG) is LAZY: the cloud shell is
    // only ever visible on the terrain basemap, yet the texture used
    // to download eagerly at init on every open — dead weight on the
    // cold-load path for the satellite default. It now loads the
    // first time the terrain layer is applied (or at init when
    // terrain IS the restored layer), and the shell stays hidden
    // until it lands (cloudTexReady gates the per-frame visibility
    // line below).
    let cloudTexReady = false;
    let cloudTexRequested = false;
    let cloudTexObj: THREE.Texture | null = null;
    const cloudMat = new THREE.MeshLambertMaterial({
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.014, 48, 32),
      cloudMat,
    );
    const ensureCloudTex = () => {
      if (cloudTexRequested) return;
      cloudTexRequested = true;
      const t = texLoader.load(earthCloudsUrl, () => {
        cloudTexReady = true;
      });
      cloudTexObj = t;
      t.colorSpace = THREE.SRGBColorSpace;
      cloudMat.map = t;
      cloudMat.needsUpdate = true;
    };
    if (layerRef.current === "terrain") ensureCloudTex();
    cloudsRef.current = clouds;
    // Clouds are OFF by default: the layer system decides their
    // visibility (terrain only, faint). On the satellite layer the
    // old cloud texture's blocky alpha mask was exactly the mosaic
    // patching the user saw over the oceans — it never shows there.
    clouds.visible = false;
    group.add(clouds);

    // ── v2.0 live-Earth layer objects ──────────────────────────────
    // Twilight glow (追霞): a shader shell whose fragment colours a
    // soft glow peaked where the solar altitude (dot of the surface
    // normal with the sun direction, in earth-local coordinates) is
    // ≈ −1.7°, feathering to nothing by +7° / −17° at 0.30 peak
    // alpha (the user-approved visible strength — see the shader
    // comment for the 0.30 → 0.16 → 0.30 history), on the EVENING
    // side only and fading out toward the poles — cross(up,
    // sunDir) points at the meridian 90° east of the subsolar point,
    // so a positive dot with it means the local sun has passed noon
    // and is descending; the dawn arc at the same altitudes is not
    // 日落 and is masked out (same hour-angle rule as solar.ts).
    // The sun uniform is refreshed by the render loop from the REAL
    // wall-clock subsolar point; visibility follows the twilightOn
    // prop mirror.
    const twilightUniform = { value: new THREE.Vector3(1, 0, 0) };
    const twilightMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.021, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: twilightUniform },
        vertexShader: `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uSunDir;
          varying vec3 vPos;
          void main() {
            vec3 n = normalize(vPos);
            vec3 sunDir = normalize(uSunDir);
            float s = dot(n, sunDir);
            // Sunset GLOW, not a band. History: the original was a
            // flat-topped solid band (the user: 太假）; the first
            // fix made it a peaked soft glow at 0.30 alpha, which
            // the user liked; a second softening (0.16 alpha, pow
            // 2.2) then made the dusk line all but INVISIBLE on his
            // phone, and he asked for the visible version back.
            // This is that version: the SAME peaked profile and
            // widened smooth skirts as the softening pass (peak at
            // the ≈ −1.7° sunset line, easing to nothing by +7°
            // above and −17° below the horizon, evening side only,
            // polar fade kept) with the peak alpha restored to
            // 0.30 — a soft amber glow you can actually see, not
            // the old solid tape.
            float glow = smoothstep(-0.30, -0.03, s) * (1.0 - smoothstep(-0.03, 0.12, s));
            glow = pow(glow, 2.2);
            float eve = smoothstep(-0.12, 0.12, dot(n, normalize(cross(vec3(0.0, 1.0, 0.0), sunDir))));
            float band = glow * eve;
            // Fade toward the poles: past ~55–60° latitude the
            // terminator geometry degenerates into polar day/night
            // and a uniform stripe running cap-to-cap is precisely
            // the painted-tape look being removed. n.y is sin(lat)
            // in earth-local coordinates.
            band *= 1.0 - smoothstep(0.78, 0.97, abs(n.y));
            vec3 col = mix(vec3(0.85, 0.36, 0.12), vec3(0.98, 0.60, 0.26), glow);
            gl_FragColor = vec4(col, band * 0.30);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    twilightMesh.renderOrder = 2;
    twilightMesh.visible = false;
    group.add(twilightMesh);
    twilightMeshRef.current = twilightMesh;
    twilightUniformRef.current = twilightUniform;

    // RainViewer overlays: satellite cloud frame (r=1.023) and radar
    // echo frame (r=1.027), both equirectangular canvases composed
    // client-side from RainViewer tiles (see rainviewer.ts). Their
    // textures are assigned by the layer effects; no frame → hidden.
    const cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.023, 48, 32),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    cloudMesh.renderOrder = 2;
    cloudMesh.visible = false;
    group.add(cloudMesh);
    cloudMeshRef.current = cloudMesh;
    const radarMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.027, 48, 32),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    radarMesh.renderOrder = 3;
    radarMesh.visible = false;
    group.add(radarMesh);
    radarMeshRef.current = radarMesh;

    // Aurora shell (v3.0): the OVATION probability field as an
    // equirect canvas, just inside the cloud shell; additive so the
    // oval glows over the night side without washing the basemap.
    // Shell opacity dropped 0.9 → 0.62 together with the field's
    // own convergence in aurora.ts — additive stacking of the old
    // pair blew the oval out to a fluorescent blob on the phone.
    const auroraMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.019, 48, 32),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    auroraMesh.renderOrder = 2;
    auroraMesh.visible = false;
    group.add(auroraMesh);
    auroraMeshRef.current = auroraMesh;

    // Space stations (sprites + ground-track lines) and live flights
    // (a single THREE.Points cloud — up to ~1500 aircraft must stay
    // ONE draw call, never 1500 sprites). Filled by layer effects.
    const stationGroup = new THREE.Group();
    group.add(stationGroup);
    stationGroupRef.current = stationGroup;
    const flightPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      flightPointsMaterial(),
    );
    flightPoints.renderOrder = 4;
    flightPoints.visible = false;
    group.add(flightPoints);
    flightPointsRef.current = flightPoints;
    // Live vessels (AIS): a second Points cloud with the ship atlas,
    // filled by its own layer effect exactly like the flights.
    const shipPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      shipPointsMaterial(),
    );
    shipPoints.renderOrder = 4;
    shipPoints.visible = false;
    group.add(shipPoints);
    shipPointsRef.current = shipPoints;
    // Windy webcams: a third Points cloud with the single-cell
    // camera atlas, filled by its own layer effect like the others.
    const webcamPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      webcamPointsMaterial(),
    );
    webcamPoints.renderOrder = 4;
    webcamPoints.visible = false;
    group.add(webcamPoints);
    webcamPointsRef.current = webcamPoints;

    // Earthquake pulse points + natural-event markers live in their
    // own groups; the layer effects fill them from props.
    const quakeGroup = new THREE.Group();
    group.add(quakeGroup);
    quakeGroupRef.current = quakeGroup;
    const eventGroup = new THREE.Group();
    group.add(eventGroup);
    eventGroupRef.current = eventGroup;

    const bordersSeg = buildBorders();
    const bordersMat = bordersSeg.material as THREE.LineBasicMaterial;
    group.add(bordersSeg);

    // China province boundaries fade in from L2 (context for the dense
    // Chinese city layer) — ice-white, one brightness step below the
    // national borders.
    const provinceLines = buildLineSegments(PROVINCES, 1.006, 0xbfe6ff, 0);
    provinceLinesMatRef.current = provinceLines.material as THREE.LineBasicMaterial;
    group.add(provinceLines);

    const countryLabels = makeLabels(
      COUNTRY_LABELS.map(([name, lat, lng]) => ({ name, lat, lng, priority: 30 })),
      { size: 40, color: "rgba(214,236,248,0.96)", scale: 0.3, radius: 1.012, tier: 0 },
    );
    for (const l of countryLabels) group.add(l.sprite);
    // Same-place dedupe at the source (edit #48): several province-
    // level units exist in BOTH plate systems with the same name at
    // effectively the same anchor — Beijing's DataV province centre
    // sits ~200 m from the library's Beijing city centre,
    // Shanghai's ~150 m, Hong Kong's / Macau's under a kilometre,
    // Chongqing's ~6 km — so at L2/L3 the province plate and the
    // city plate draw the same place twice, a few pixels apart
    // (the user's recording: 北京 / 上海 / 重庆 read as doubled
    // name plates). The pooled placement pass has a same-name
    // dedupe for this, but the pair should never reach it: for
    // these units the province IS its city, so the province plate
    // set simply skips any province whose name matches a library
    // city within ~10 km of that city's anchor, leaving the
    // (brighter, higher-priority) city plate as the one and only
    // label for the place at every zoom. Tianjin is NOT in this
    // class (its library anchor is the Binhai point, ~26 km from
    // the province centre — two genuinely separated anchors), and
    // different-name neighbours （广东 the province vs 广州 the
    // city, 陕西 vs 西安） are two places' names; both keep both
    // plates and the collision pass arbitrates their overlap.
    const provinceLabels = makeLabels(
      PROVINCES.filter((p) => {
        if (!p.center) return false;
        const [clng, clat] = p.center as [number, number];
        const dup = CITIES.some(
          (c) =>
            c.zh === p.name &&
            Math.hypot(
              (c.lng - clng) * Math.cos((clat * Math.PI) / 180),
              c.lat - clat,
            ) < 0.09,
        );
        return !dup;
      }).map((p) => ({
        name: p.name,
        lat: (p.center as [number, number])[1],
        lng: (p.center as [number, number])[0],
        priority: 45,
      })),
      { size: 38, color: "rgba(214,240,255,0.97)", scale: 0.21, radius: 1.013, tier: 9 },
    );
    for (const l of provinceLabels) group.add(l.sprite);
    provinceLabelsRef.current = provinceLabels;

    // ── Chunked build queue ─────────────────────────────────────────
    // Canvas label textures are the most expensive objects in this
    // scene (a tier holds 77–245 of them). Building a whole tier in the
    // frame where the camera crosses its zoom gate froze taps for
    // seconds on phones, so ALL heavy construction (tier labels,
    // admin_1 line chunks, focused-province labels) is sliced into
    // small jobs that the render loop drains a fixed count per frame
    // — the globe stays draggable while they stream in.
    type BuildJob = () => void;
    const buildJobs: BuildJob[] = [];
    // Name plates for the place the user is actively looking at (the
    // focused country's ADM1 regions, the focused province's
    // prefectures) take a priority lane: they drain first, every
    // frame, ahead of boundary-line chunks and background tier
    // prebuilds, so the names appear within a frame or two of the
    // camera arriving instead of after hundreds of line chunks.
    const priorityJobs: BuildJob[] = [];
    const drainBuildJobs = () => {
      // Count-based drain — deliberately NOT a performance.now()
      // time budget. In throttled / timer-coarsened contexts
      // (hardened webviews, frame-capture harnesses) performance
      // .now() can jump a whole frame tick (~16ms) between two
      // adjacent calls; a `now - start < 6ms` gate then fails at
      // entry on every frame and silently starves EVERY queued
      // layer — region plates, tier-2/3 city plates, county lines —
      // while the globe itself keeps rendering (measured in situ:
      // 312 drain calls, 0 jobs run, adjacent performance.now()
      // calls 16.00ms apart). A per-frame job count always makes
      // progress, and each job's cost is small and bounded.
      let n = 0;
      while (priorityJobs.length > 0 && n < 14) {
        const job = priorityJobs.shift();
        if (job) {
          n++;
          job();
        }
      }
      n = 0;
      while (buildJobs.length > 0 && n < 10) {
        const job = buildJobs.shift();
        if (job) {
          n++;
          job();
        }
      }
    };
    const scheduleIdle = (cb: () => void, delayMs: number) => {
      const w = window as unknown as {
        requestIdleCallback?: (
          fn: () => void,
          opts?: { timeout: number },
        ) => number;
      };
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(cb, { timeout: 3000 });
      } else {
        window.setTimeout(cb, delayMs);
      }
    };

    // ── Extra boundary layers (lazy) ────────────────────────────────
    // Province/state boundaries for ALL countries (geoBoundaries
    // gbOpen ADM1, dynamically imported the first time the camera
    // closes in, so it never weighs on first paint or the fullscreen
    // entry frame. China is not in this asset — its provinces come
    // from the finer DataV set above.
    let admin1Mat: THREE.LineBasicMaterial | null = null;
    let admin1Requested = false;
    // China prefecture (city) boundaries + city names for whichever
    // province is centred at L3; built on demand per province, cached by
    // simply keeping the last one (switching disposes the old group).
    let cityAdminGroup: THREE.Group | null = null;
    let cityAdminProvince: string | null = null;
    let cityAdminLabels: LabelRec[] = [];
    let cityAdminMat: THREE.LineBasicMaterial | null = null;
    // Tap targets for the focused province's prefecture plates, kept
    // in lockstep with cityAdminLabels (same units, same centres):
    // the plates are what the user reads at deep zoom, so they are
    // what pickTarget hit-tests.
    interface AdminPick {
      name: string;
      full: string;
      lat: number;
      lng: number;
      dir: THREE.Vector3;
    }
    let cityAdminPicks: AdminPick[] = [];
    // Bumped on every province switch: queued label jobs for a province
    // the view has already left check the token and quietly drop out.
    let cityAdminToken = 0;
    const setCityAdminProvince = (name: string | null) => {
      if (name === cityAdminProvince) return;
      cityAdminProvince = name;
      cityAdminToken++;
      if (cityAdminGroup) {
        group.remove(cityAdminGroup);
        cityAdminGroup.traverse((obj) => {
          const anyObj = obj as unknown as {
            geometry?: THREE.BufferGeometry;
            material?: THREE.Material;
          };
          anyObj.geometry?.dispose();
          anyObj.material?.dispose();
        });
        cityAdminGroup = null;
      }
      cityAdminLabels = [];
      cityAdminPicks = [];
      cityAdminMat = null;
      if (!name) return;
      const units: AdminUnit[] | undefined = CITIES_BY_PROVINCE[name];
      if (!units || units.length === 0) return; // e.g. Taiwan: province only
      const g = new THREE.Group();
      const lines = buildLineSegments(
        units,
        1.007,
        layerRef.current === "simple" ? 0xb4bfc4 : 0xd6f0ff,
        0,
      );
      cityAdminMat = lines.material as THREE.LineBasicMaterial;
      g.add(lines);
      cityAdminGroup = g;
      group.add(g);
      // City name plates stream in through the build queue (a province
      // carries ~10–20 of them) instead of landing in one frame.
      const token = cityAdminToken;
      const target = cityAdminLabels;
      for (const u of units) {
        if (u.center == null) continue;
        const center = u.center;
        // The plate's tap target lands together with the plate.
        cityAdminPicks.push({
          name: u.name,
          full: u.full,
          lat: center[1],
          lng: center[0],
          dir: latLngToVec3(center[1], center[0], 1).normalize(),
        });
        priorityJobs.push(() => {
          if (token !== cityAdminToken) return;
          const l = makeLabel(
            // Priority 110 (was 52, then 90): prefecture names are
            // the L3/L4 headline layer for China — at 52 they ranked
            // below every tier-3 city, and at 90 still below the
            // ~30 tier-1/tier-2-capital plates (100+) facing the
            // camera, so on the tightest label budget (36) only 2
            // of Yunnan's 16 placed (measured at Dali). At 110 they
            // sit above plain tier-1/tier-2-capital city plates —
            // the focused province's own subdivisions are the
            // subject of this zoom level — and below capitals
            // (120), the hovered and the active city.
            { name: u.name, lat: center[1], lng: center[0], priority: 110 },
            {
              size: 32,
              color: "rgba(214,240,255,0.95)",
              scale: 0.125,
              radius: 1.014,
              tier: 8,
            },
          );
          g.add(l.sprite);
          target.push(l);
        });
      }
    };

    // ── County-level (ADM2) boundaries for the focused country ──────
    // geoBoundaries gbOpen ADM2, one country's rings at a time (the
    // asset is far too large to build whole). China never uses this —
    // its prefecture layer above comes from the finer DataV set. The
    // module itself is lazy-imported on first deep zoom, like ADM1.
    let admin2Group: THREE.Group | null = null;
    let admin2Iso: string | null = null;
    let admin2Mat: THREE.LineBasicMaterial | null = null;
    let admin2Token = 0;
    let admin2Module: typeof import("./assets/admin2") | null = null;
    let admin2Requested = false;
    const disposeGroup = (g: THREE.Group) => {
      group.remove(g);
      g.traverse((obj) => {
        const anyObj = obj as unknown as {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material;
        };
        anyObj.geometry?.dispose();
        anyObj.material?.dispose();
      });
    };
    const setAdmin2Country = (iso: string | null) => {
      if (iso === admin2Iso) return;
      admin2Iso = iso;
      admin2Token++;
      if (admin2Group) {
        disposeGroup(admin2Group);
        admin2Group = null;
      }
      admin2Mat = null;
      if (!iso) return;
      const build = (mod: typeof import("./assets/admin2")) => {
        const rings = mod.getAdmin2Rings(iso);
        if (!rings || rings.length === 0) return;
        const token = admin2Token;
        const g = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({
          color: layerRef.current === "simple" ? 0xb4bfc4 : 0xd6f0ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        admin2Mat = mat;
        admin2Group = g;
        group.add(g);
        for (let i = 0; i < rings.length; i += 110) {
          const slice = rings.slice(i, i + 110);
          buildJobs.push(() => {
            if (token !== admin2Token) return;
            const seg = buildLineSegments(
              slice.map((ring) => ({ rings: [ring] })),
              1.007,
              0xd6f0ff,
              0,
            );
            (seg.material as THREE.Material).dispose();
            seg.material = mat;
            g.add(seg);
          });
        }
      };
      if (admin2Module) {
        build(admin2Module);
      } else {
        if (!admin2Requested) {
          admin2Requested = true;
          void import("./assets/admin2")
            .then((m) => {
              admin2Module = m;
              if (admin2Iso) {
                // Re-run for whichever country is focused by now.
                const cur = admin2Iso;
                admin2Iso = null;
                setAdmin2Country(cur);
              }
            })
            .catch(() => {
              // No ADM2 layer — ADM1 + borders still show.
            });
        }
        // Module still loading: the .then above rebuilds for the
        // then-current country; nothing more to do now.
      }
    };

    // ── ADM1 region NAME plates for the focused country ────────────
    // Built per focused country (like the ADM2 boundaries above) from
    // the geoBoundaries gbOpen name list: every ADM1 region of the
    // country gets a plate at its dataset representative point, plus
    // a tap target kept in lockstep — pickTarget resolves a hit to
    // the same gb: place the region picker opens. China never uses
    // this layer: its DataV province plates above already name every
    // province. The regions module is lazy-imported on first need.
    interface RegionPick {
      idx: number;
      // Display name (Chinese where REGION_ZH_NAMES has a sourced
      // name, else the dataset name) + the raw dataset name, kept
      // for the card's English line / photo lookup.
      name: string;
      nameEn: string;
      countryName: string;
      iso: string;
      lat: number;
      lng: number;
      dir: THREE.Vector3;
    }
    let regionGroup: THREE.Group | null = null;
    let regionLabels: LabelRec[] = [];
    let regionPicks: RegionPick[] = [];
    let regionCountryIso: string | null = null;
    let regionToken = 0;
    let regionsModule: typeof import("./assets/regions") | null = null;
    let regionsRequested = false;
    const setRegionCountry = (iso: string | null) => {
      if (iso === regionCountryIso) return;
      regionCountryIso = iso;
      regionToken++;
      if (regionGroup) {
        disposeGroup(regionGroup);
        regionGroup = null;
      }
      regionLabels = [];
      regionPicks = [];
      if (!iso) return;
      const build = (mod: typeof import("./assets/regions")) => {
        const isoIdx = GB_COUNTRIES.findIndex((c) => c.iso === iso);
        if (isoIdx < 0) return;
        const country = GB_COUNTRIES[isoIdx];
        if (!country) return;
        const token = regionToken;
        const g = new THREE.Group();
        regionGroup = g;
        group.add(g);
        const target = regionLabels;
        mod.GB_ADM1.forEach((r, i) => {
          if (r[0] !== isoIdx) return;
          const displayName = REGION_ZH_NAMES[iso]?.[r[1]] ?? r[1];
          // The tap target lands together with the plate job below.
          regionPicks.push({
            idx: i,
            name: displayName,
            nameEn: r[1],
            countryName: country.name,
            iso,
            lat: r[2],
            lng: r[3],
            dir: latLngToVec3(r[2], r[3], 1).normalize(),
          });
          priorityJobs.push(() => {
            if (token !== regionToken) return;
            // Priority 85 + tier 7 (K 1.5): collision placement is
            // greedy by priority, and a region plate's rect spans
            // much of its region — at a meek priority (44, below
            // every city tier) the region's OWN cities voted its
            // name off the map in every settled view tested
            // (France: not one of 13 plates ever won a frame). At
            // 85 a region yields only to tier-1 cities (a capital
            // keeps its plate over its region's — Paris over
            // Île-de-France) and in turn displaces the tier-2/3
            // city plates it overlaps, which is the right
            // composition at region zoom: the region name is the
            // headline, its smaller cities reappear as the camera
            // dives and separations grow.
            const l = makeLabel(
              {
                name: displayName,
                // The dataset name rides along as altName so the
                // same-place dedupe against city plates (which know
                // places by their English names too) keeps working
                // under the Chinese display name.
                altName: displayName !== r[1] ? r[1] : undefined,
                lat: r[2],
                lng: r[3],
                priority: 85,
              },
              {
                size: 34,
                color: "rgba(168,216,240,0.92)",
                scale: 0.16,
                radius: 1.0135,
                tier: 7,
              },
            );
            g.add(l.sprite);
            target.push(l);
          });
        });
      };
      if (regionsModule) {
        build(regionsModule);
      } else if (!regionsRequested) {
        regionsRequested = true;
        void import("./assets/regions")
          .then((m) => {
            regionsModule = m;
            if (regionCountryIso) {
              // Re-run for whichever country is focused by now.
              const cur = regionCountryIso;
              regionCountryIso = null;
              setRegionCountry(cur);
            }
          })
          .catch(() => {
            // No region-name layer — boundaries + picker still work.
          });
      }
    };

    // Atmosphere: fresnel shell on the back side, radius 1.10. The
    // L5 camera floor (1.06) now dives INSIDE this shell, so the
    // shell carries a uFade uniform: the render loop eases it to 0
    // as the camera closes below ~1.25 and hides the mesh before
    // the camera reaches the shell — from inside, an unfaded
    // BackSide fresnel would wash the whole frame out. At globe
    // distances uFade is 1 and the halo renders exactly as before.
    const atmosphereFade = { value: 1 };
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: { uFade: atmosphereFade },
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float uFade;
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.5);
            gl_FragColor = vec4(0.22, 0.5, 0.92, 1.0) * intensity * 0.5 * uFade;
          }`,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(atmosphere);

    // Starfield (subtle).
    const starCount = 1100;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 60);
      starPos[i * 3] = v.x;
      starPos[i * 3 + 1] = v.y;
      starPos[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const dotTex = softDotTexture();
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        map: dotTex,
        color: 0x8fb0cc,
        size: 1.4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    scene.add(stars);

    // City records: position + facing direction only. The per-city dot
    // sprites are GONE (user: the map full of white dots was ugly) —
    // the name plates built below are the only city markers, and
    // pickTarget below hit-tests against their projected positions.
    const markersGroup = new THREE.Group();
    group.add(markersGroup);
    markersGroupRef.current = markersGroup;
    const recs: CityRec[] = CITIES.map((city) => {
      const p = latLngToVec3(city.lat, city.lng, 1.012);
      return { city, dir: p.clone().normalize() };
    });
    cityRecsRef.current = recs;

    // Selection fallback dot: a few screen pixels wide, shown ONLY
    // when the selected point resolves to no administrative unit
    // (open ocean, unclaimed land) — the giant white ring-and-needle
    // pin it replaces is gone for good; places with a unit get the
    // boundary highlight instead (see the highlight effect below).
    const selDot = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dotTex,
        color: new THREE.Color(0xbfe9ff),
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    selDot.renderOrder = 4;
    selDot.visible = false;
    markersGroup.add(selDot);
    selDotRef.current = selDot;

    // Lazily build one tier of city name labels. ALL tiers are QUEUED
    // as one job per plate and drained a fixed count per frame (see
    // drainBuildJobs in the loop): the old behaviours — building ~245
    // tier-3 canvas textures inside the frame where a tap's fly-to
    // crossed the zoom gate, and (until edit #27) building tier 1's
    // 44 textures synchronously before the first frame — were the
    // multi-second freezes users hit on tap and on cold open. Tier 1
    // drains from the priority lane so the opening view's plates land
    // within the first few frames; tiers 2/3 are also pre-queued
    // during idle time after first paint, so they are usually ready
    // before the first zoom-in ever needs them.
    const queuedLabelTiers = new Set<number>();
    const ensureTierLabels = (tier: number) => {
      if (
        builtLabelTiersRef.current.has(tier) ||
        queuedLabelTiers.has(tier)
      ) {
        return;
      }
      // Plates are grouped by LABEL tier, not size tier: demoted tier-1
      // cities (Tianjin, Nanjing, …) are built with the tier-2 set and
      // only ever appear once the camera reaches the L2 band.
      const items = CITIES.filter((c) => c.labelTier === tier);
      const basePrio = tier === 1 ? 100 : tier === 2 ? 80 : 60;
      const opts = {
        size: tier === 1 ? 42 : tier === 2 ? 38 : 34,
        color:
          tier === 1
            ? "rgba(242,249,255,0.98)"
            : tier === 2
              ? "rgba(191,227,255,0.97)"
              : "rgba(220,238,251,0.96)",
        scale: 0.2,
        radius: 1.03,
        tier,
      };
      // Tier 1 takes the PRIORITY lane (edit #27): it used to be
      // built synchronously here — 44 canvas textures inside the
      // init effect, before the first frame could render — which was
      // a real slice of the cold-open freeze the user reported. Now
      // the first frame paints the bare globe immediately and the
      // plates stream in over the first few frames (14 jobs/frame),
      // exactly like tiers 2/3 stream from the normal queue.
      const queue = tier === 1 ? priorityJobs : buildJobs;
      queuedLabelTiers.add(tier);
      const recs: LabelRec[] = [];
      cityLabelsRef.current.set(tier, recs);
      for (const c of items) {
        queue.push(() => {
          const l = makeLabel(
            {
              name: c.zh,
              altName: c.en,
              lat: c.lat,
              lng: c.lng,
              // Priority: label tier first, capitals get a solid bonus so
              // a capital wins its screen space over a same-tier neighbour.
              priority: basePrio + (c.capital ? 20 : 0),
              cityId: c.id,
            },
            opts,
          );
          group.add(l.sprite);
          recs.push(l);
        });
      }
      queue.push(() => {
        builtLabelTiersRef.current.add(tier);
      });
    };
    ensureTierLabels(1);
    // Idle-time prebuild: after the first frames settle, queue tier 2,
    // then tier 3, so a later tap/zoom finds its plates already built.
    scheduleIdle(() => {
      ensureTierLabels(2);
      scheduleIdle(() => ensureTierLabels(3), 1200);
    }, 900);

    // --- interaction state ---
    const pointers = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let moved = 0;
    let pinchDist = 0;
    const el = renderer.domElement;

    const applyDrag = (dx: number, dy: number) => {
      // Angular speed scales with the camera's height above the
      // surface: full speed (0.005 rad/px) at the L1 resting distance,
      // easing down proportionally as the camera closes in so the
      // ground tracks the finger at every zoom. The floor dropped
      // 15% → 3% with the L5 extension: at the new floor (height
      // 0.06) true finger tracking needs k ≈ 0.005 × 0.06/1.95, and
      // the old 15% floor would have flung the L5 patch ~5× too
      // fast per pixel — the "滑动太快" complaint, one level down.
      const k =
        0.005 *
        THREE.MathUtils.clamp(
          (currentDistRef.current - 1) / (2.95 - 1),
          0.03,
          1,
        );
      // Orbit drag (edit #27): the drag moves the view CENTRE along
      // the sphere's arc lines instead of rotating a free quaternion
      // — horizontal sweeps longitude along the parallel (grab-style:
      // dragging right pulls the surface right, so the centre moves
      // to lower longitude), vertical pitches along the meridian
      // (dragging down pulls the surface down, centre latitude
      // rises), clamped to ±ORBIT_TILT_MAX so the view never flips
      // over a pole. Signs verified numerically against the old
      // model's centre movement (pure dy matched exactly; pure dx
      // matched in longitude, minus the old model's parasitic roll
      // and latitude coupling, which are precisely what is being
      // removed).
      const kDeg = (k * 180) / Math.PI;
      const o = goalOrbitRef.current;
      o.lng -= dx * kDeg;
      if (o.lng < -180) o.lng += 360;
      if (o.lng > 180) o.lng -= 360;
      o.lat = THREE.MathUtils.clamp(o.lat + dy * kDeg, -ORBIT_TILT_MAX, ORBIT_TILT_MAX);
      syncGoalFromOrbit();
    };

    // Picking without dot sprites: project every city whose LABEL tier
    // is open at the current zoom to screen pixels and take the
    // nearest plate centre within a finger-friendly radius. "What you
    // can read is what you can tap" — a city whose plate tier hasn't
    // opened yet isn't tappable either, which keeps dense L1 clusters
    // unambiguous (Beijing wins its own tap zone; Tianjin joins in at
    // L2 when its plate appears).
    //
    // At deep zoom the same rule covers the focused province's
    // prefecture plates: they are drawn from the admin data (~333
    // units), not from the 366-city library, so hit-testing only the
    // library left most of them dead — and even a library prefecture's
    // plate sits at the admin centre, which at max zoom can project
    // well beyond the pick radius of the library coordinates. An admin
    // hit resolves exactly like the region picker: a unit that is in
    // the library selects the library city; any other unit opens its
    // own weather card from the unit centre.
    type PickTarget =
      | { kind: "city"; rec: CityRec }
      | { kind: "admin"; place: GlobeAdminPlace }
      | { kind: "quake"; q: GlobeQuake }
      | { kind: "event"; e: GlobeEvent }
      | { kind: "station"; s: GlobeStation }
      | { kind: "flight"; f: GlobeFlight }
      | { kind: "ship"; s: GlobeShip }
      | { kind: "webcam"; w: GlobeWebcam };
    const pickVec = new THREE.Vector3();
    const pickTarget = (clientX: number, clientY: number): PickTarget | null => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const dist = currentDistRef.current;
      const invQ = group.quaternion.clone().invert();
      const camDirLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(invQ);
      let bestCity: CityRec | null = null;
      let bestCityPx = 36;
      for (const r of cityRecsRef.current) {
        if (!showWeatherRef.current) break;
        // Same gate that draws the plate — plus the twilight-band
        // exception: a band city whose plate is force-shown at this
        // zoom stays tappable (what you can read is what you can tap).
        const inBandPick =
          twilightOnRef.current &&
          bandCitySetRef.current?.has(r.city.id) === true;
        if (labelGate(r.city.labelTier, dist) <= 0.05 && !inBandPick) continue;
        if (r.dir.dot(camDirLocal) < 0.2) continue;
        pickVec
          .copy(r.dir)
          .applyQuaternion(group.quaternion)
          .multiplyScalar(1.03)
          .project(camera);
        if (pickVec.z > 1 || pickVec.z < -1) continue;
        const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
        const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestCityPx) {
          bestCityPx = d;
          bestCity = r;
        }
      }
      // Prefecture plates of the focused province — same gate that
      // draws them (province focus only exists below dist 2.12).
      let bestAdmin: AdminPick | null = null;
      let bestAdminPx = 36;
      if (dist < 2.12 && cityAdminProvince) {
        for (const p of cityAdminPicks) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestAdminPx) {
            bestAdminPx = d;
            bestAdmin = p;
          }
        }
      }
      // ADM1 region plates of the focused country (every country
      // except China, whose provinces carry DataV plates instead) —
      // same gate band that fades the plates in (dist < 2.66).
      let bestRegion: RegionPick | null = null;
      let bestRegionPx = 36;
      if (dist < 2.66) {
        for (const p of regionPicks) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestRegionPx) {
            bestRegionPx = d;
            bestRegion = p;
          }
        }
      }
      // v2.0 event-layer markers: projected like the plates, nearest
      // centre within 34px; they win only when strictly nearest, so
      // a city plate under the same tap keeps its priority on ties.
      let bestQuake: GlobeQuake | null = null;
      let bestQuakePx = 34;
      if (showQuakesRef.current) {
        for (const p of quakePicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestQuakePx) {
            bestQuakePx = d;
            bestQuake = p.q;
          }
        }
      }
      let bestEvent: GlobeEvent | null = null;
      let bestEventPx = 34;
      if (showEventsRef.current) {
        for (const p of eventPicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestEventPx) {
            bestEventPx = d;
            bestEvent = p.e;
          }
        }
      }
      // v3.0 markers: stations (labelled sprites, 36px) and flights
      // (dense Points cloud, tighter 24px radius so a stray aircraft
      // never steals a tap meant for the ground).
      let bestStation: GlobeStation | null = null;
      let bestStationPx = 36;
      if (showStationsRef.current) {
        for (const p of stationPicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestStationPx) {
            bestStationPx = d;
            bestStation = p.s;
          }
        }
      }
      let bestFlight: GlobeFlight | null = null;
      let bestFlightPx = 24;
      if (showFlightsRef.current) {
        for (const p of flightPicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.03)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestFlightPx) {
            bestFlightPx = d;
            bestFlight = p.f;
          }
        }
      }
      let bestShip: GlobeShip | null = null;
      let bestShipPx = 24;
      if (showShipsRef.current) {
        for (const p of shipPicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.024)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestShipPx) {
            bestShipPx = d;
            bestShip = p.s;
          }
        }
      }
      let bestWebcam: GlobeWebcam | null = null;
      let bestWebcamPx = 22;
      if (showWebcamsRef.current) {
        for (const p of webcamPicksRef.current) {
          if (p.dir.dot(camDirLocal) < 0.2) continue;
          pickVec
            .copy(p.dir)
            .applyQuaternion(group.quaternion)
            .multiplyScalar(1.026)
            .project(camera);
          if (pickVec.z > 1 || pickVec.z < -1) continue;
          const sx = (pickVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-pickVec.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - px, sy - py);
          if (d < bestWebcamPx) {
            bestWebcamPx = d;
            bestWebcam = p.w;
          }
        }
      }
      const plateBestPx = Math.min(
        bestCity ? bestCityPx : Infinity,
        bestAdmin ? bestAdminPx : Infinity,
        bestRegion ? bestRegionPx : Infinity,
      );
      if (
        bestStation &&
        bestStationPx <= plateBestPx &&
        bestStationPx <= bestQuakePx &&
        bestStationPx <= bestEventPx
      ) {
        return { kind: "station", s: bestStation };
      }
      if (bestQuake && bestQuakePx <= plateBestPx && bestQuakePx <= bestEventPx) {
        return { kind: "quake", q: bestQuake };
      }
      if (bestEvent && bestEventPx <= plateBestPx) {
        return { kind: "event", e: bestEvent };
      }
      if (bestFlight && bestFlightPx < plateBestPx) {
        return { kind: "flight", f: bestFlight };
      }
      if (bestShip && bestShipPx < plateBestPx) {
        return { kind: "ship", s: bestShip };
      }
      if (bestWebcam && bestWebcamPx < plateBestPx) {
        return { kind: "webcam", w: bestWebcam };
      }
      // Nearest centre wins across all three plate kinds. A region
      // hit resolves to the identical place the region picker's
      // 全球行政区 entry opens (same gb: id), so its weather card,
      // photo cache and naming all line up.
      if (
        bestRegion &&
        bestRegionPx <= (bestCity ? bestCityPx : Infinity) &&
        bestRegionPx <= (bestAdmin ? bestAdminPx : Infinity)
      ) {
        const p = bestRegion;
        return {
          kind: "admin",
          place: {
            id: `gb:${p.iso}-${p.idx}`,
            zh: p.name,
            en: p.nameEn,
            country: p.countryName,
            region: p.name,
            lat: p.lat,
            lng: p.lng,
            tz: "auto",
            wiki: p.nameEn,
          },
        };
      }
      if (bestAdmin && (!bestCity || bestAdminPx <= bestCityPx)) {
        const province = cityAdminProvince as string;
        const lib = CITIES.find(
          (c) =>
            c.country === "中国" &&
            c.region === province &&
            c.zh === bestAdmin.name,
        );
        if (lib) {
          const rec = cityRecsRef.current.find((r) => r.city.id === lib.id);
          if (rec) return { kind: "city", rec };
        }
        return {
          kind: "admin",
          place: {
            id: `sub:cn-${province}-${bestAdmin.name}`,
            zh: bestAdmin.full,
            en: bestAdmin.full,
            country: "中国",
            region: province,
            lat: bestAdmin.lat,
            lng: bestAdmin.lng,
            tz: "Asia/Shanghai",
            wiki: bestAdmin.full,
          },
        };
      }
      return bestCity ? { kind: "city", rec: bestCity } : null;
    };

    // Tap-anywhere: when no plate is hit, raycast onto the earth mesh
    // itself and convert the hit to lat/lng. This is what makes EVERY
    // place on the planet selectable — the tapped point's weather is
    // fetched live and its name reverse-geocoded server-side.
    const raycaster = new THREE.Raycaster();
    const ndcVec = new THREE.Vector2();
    const pickPoint = (clientX: number, clientY: number): { lat: number; lng: number } | null => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      ndcVec.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndcVec, camera);
      const hits = raycaster.intersectObject(earth, false);
      const hit = hits[0];
      if (!hit) return null;
      const local = group.worldToLocal(hit.point.clone());
      const r = local.length();
      if (r < 0.5) return null;
      const lat =
        90 -
        (Math.acos(THREE.MathUtils.clamp(local.y / r, -1, 1)) * 180) / Math.PI;
      let lng = (Math.atan2(local.z, -local.x) * 180) / Math.PI - 180;
      if (lng < -180) lng += 360;
      if (lng > 180) lng -= 360;
      return { lat, lng };
    };

    const onPointerDown = (e: PointerEvent) => {
      // The movement tally resets only when a FRESH gesture starts:
      // resetting it when the second pinch finger lands let a
      // pinch-end read as a near-zero-movement tap (see onPointerUp).
      const freshGesture = pointers.size === 0;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      dragging = true;
      if (freshGesture) moved = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      callbacksRef.current.onInteract();
    };
    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // Hover highlight (mouse only): the nearest open plate centre
        // within the pick radius drives the cursor + collision boost.
        if (e.pointerType === "mouse") {
          const t = pickTarget(e.clientX, e.clientY);
          hoverIdRef.current = t?.kind === "city" ? t.rec.city.id : null;
          el.style.cursor = t ? "pointer" : "grab";
        }
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist > 0) {
            goalDistRef.current = THREE.MathUtils.clamp(goalDistRef.current * (pinchDist / d), MIN_DIST, MAX_DIST);
          }
          pinchDist = d;
        }
        moved += Math.abs(dx) + Math.abs(dy);
        return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 3) applyDrag(dx, dy);
    };
    const onPointerUp = (e: PointerEvent) => {
      const wasClick = dragging && moved <= 5 && pointers.size === 1;
      pointers.delete(e.pointerId);
      // A pinch just ended (one finger still down): poison the tally
      // so the remaining finger's lift can't be read as a tap — a
      // phantom tap at deep zoom flies the camera back to the tapped
      // place's resting distance, which is exactly the "zoomed all
      // the way in and it popped back out" complaint.
      if (pointers.size === 1) moved = Math.max(moved, 6);
      if (pointers.size === 0) dragging = false;
      if (wasClick) {
        const t = pickTarget(e.clientX, e.clientY);
        if (t?.kind === "city") {
          callbacksRef.current.onCityClick(t.rec.city.id);
        } else if (t?.kind === "admin") {
          callbacksRef.current.onAdminClick?.(t.place);
        } else if (t?.kind === "quake") {
          callbacksRef.current.onQuakeClick?.(t.q);
        } else if (t?.kind === "event") {
          callbacksRef.current.onEventClick?.(t.e);
        } else if (t?.kind === "station") {
          callbacksRef.current.onStationClick?.(t.s);
        } else if (t?.kind === "flight") {
          callbacksRef.current.onFlightClick?.(t.f);
        } else if (t?.kind === "ship") {
          callbacksRef.current.onShipClick?.(t.s);
        } else if (t?.kind === "webcam") {
          callbacksRef.current.onWebcamClick?.(t.w);
        } else {
          // No plate hit → the sphere itself: any place on Earth.
          const pt = pickPoint(e.clientX, e.clientY);
          if (pt) callbacksRef.current.onPointClick?.(pt.lat, pt.lng);
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      goalDistRef.current = THREE.MathUtils.clamp(goalDistRef.current * (1 + e.deltaY * 0.001), MIN_DIST, MAX_DIST);
      callbacksRef.current.onInteract();
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    let viewW = 1;
    let viewH = 1;
    // Guarded resize: during an Android fullscreen transition the mount
    // can transiently measure 0×0 (or a mid-animation size) — applying
    // that would collapse the drawing buffer and strand a blank canvas.
    // Sub-2px measurements are ignored (the last good size stays), all
    // observer/event resizes are debounced through rAF, and a settle
    // pass re-measures once the transition has finished.
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 2 || h < 2) return;
      viewW = w;
      viewH = h;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    let resizeQueued = false;
    const queueResize = () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resize();
      });
    };
    resize();
    const ro = new ResizeObserver(queueResize);
    ro.observe(mount);

    // Fullscreen is where frame budgets collapse (large landscape canvas
    // on phone GPUs), so it gets its own stricter pixel-ratio cap, and
    // the render loop reads fsMode to pause the cloud drift there.
    // "Fullscreen" here means native OR the immersive fallback — the
    // fallback presents the same full-viewport canvas and needs the
    // same relief on phone GPUs.
    const isFs = () =>
      Boolean(document.fullscreenElement) || immersiveRef.current;
    let fsMode = isFs();
    let fsSettleTimer = 0;
    // Timestamp of the last fullscreen transition (native change or
    // immersive toggle — syncFsPerf is the single funnel for both).
    // The recovery paths below consult it: a WebGL context loss or a
    // burst of failing frames DURING a fullscreen surface swap is a
    // known, self-healing transient, and must never escalate into a
    // scene rebuild the user would read as the page reloading itself
    // (edit #22, suspect B — the page never reloads itself, and after
    // this gating a fullscreen switch alone can't even rebuild it).
    let lastFsTransitionAt = 0;
    const syncFsPerf = () => {
      fsMode = isFs();
      lastFsTransitionAt = performance.now();
      try {
        const cap = fsMode ? 1.75 : maxPR;
        if (pixelRatio > cap) {
          pixelRatio = cap;
          renderer.setPixelRatio(pixelRatio);
        }
      } catch {
        // A pixel-ratio hiccup must never break the transition.
      }
      queueResize();
      window.clearTimeout(fsSettleTimer);
      fsSettleTimer = window.setTimeout(resize, 300);
    };
    fsSyncRef.current = syncFsPerf;
    const onFsChange = () => syncFsPerf();
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);

    // Label collision-avoidance pools (reused every frame).
    const candPool: LabelCand[] = [];
    const candOrder: LabelCand[] = [];
    const winners: LabelCand[] = [];
    let candCount = 0;
    // Scratch pool for the ADM1 region-plate pass: same rect shape
    // as LabelCand plus the facing used to order the thinning.
    interface RegionCand {
      rec: LabelRec;
      op: number;
      x: number;
      y: number;
      hw: number;
      hh: number;
      facing: number;
    }
    const regionPool: RegionCand[] = [];
    const regionOrder: RegionCand[] = [];
    const regionPlaced: Array<{ x: number; y: number; hw: number; hh: number }> = [];
    const tmpWorld = new THREE.Vector3();
    const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(21)); // camera fov 42°
    const LABEL_PAD_X = 6;
    const LABEL_PAD_Y = 5;

    // Screen-space label sizing: invert the perspective projection
    // for a plate at `depth` (camera → plate) so its glyph ink
    // (inkFrac = textHFrac of the sprite's height) lands at the
    // tier's fixed CSS-pixel height (LABEL_INK_PX) at ANY zoom —
    // L5 included: a centred plate's depth at the 1.06 floor is
    // ~0.03–0.05, which the old 0.05 degenerate guard misread as
    // "near-zero" and fell back to the v14 world scale (~20× too
    // big on screen). The guard is 0.008 now — below any real plate
    // depth (the dynamic near plane keeps visible geometry ≥ that)
    // and still safely above degenerate zero.
    // Degenerate inputs — non-finite or near-zero depth, no ink
    // fraction, no viewport — return the caller's v14 world-scale
    // size (dist × 0.0305 × K × shrink) untouched, so a bad plate
    // can never produce a NaN/absurd scale.
    const plateWorldHeight = (
      depth: number,
      tier: number,
      inkFrac: number,
      fallback: number,
    ): number => {
      const px = LABEL_INK_PX[tier];
      if (
        px == null ||
        !Number.isFinite(depth) ||
        depth <= 0.008 ||
        !Number.isFinite(inkFrac) ||
        inkFrac <= 0 ||
        !(viewH > 0)
      ) {
        return fallback;
      }
      const h = (px * 2 * depth * TAN_HALF_FOV) / (viewH * inkFrac);
      return Number.isFinite(h) && h > 0 ? h : fallback;
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cloudStep = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.00007);
    const tmpDir = new THREE.Vector3();
    const camDir = new THREE.Vector3(0, 0, 1);

    // ── WebGL context loss / restore ────────────────────────────────
    // The Android fullscreen white screen: entering/leaving fullscreen
    // swaps the canvas surface, and Chrome on several Android GPUs
    // revokes the WebGL context mid-transition. Without a handler the
    // canvas simply never draws again. preventDefault() opts into
    // restoration; we then (a) pause rendering while lost, (b) ask for
    // an expedited restore, (c) on restore flag every texture for
    // re-upload and re-measure, and (d) if nothing comes back within
    // ~6s, the React overlay offers a one-tap full scene rebuild.
    let glLost = false;
    let ctxRestoreTimer = 0;
    let ctxRebuildTimer = 0;
    const canvasEl = renderer.domElement;
    const onCtxLost = (e: Event) => {
      e.preventDefault();
      glLost = true;
      setCtxLost(true);
      window.clearTimeout(ctxRestoreTimer);
      ctxRestoreTimer = window.setTimeout(() => {
        try {
          renderer.forceContextRestore();
        } catch {
          // Restore is best-effort; the rebuild below is the fallback.
        }
      }, 1200);
      // If the context still hasn't come back after ~6s, don't leave
      // the user staring at the recovery overlay: rebuild the scene
      // automatically (same as the overlay's button, no tap needed) —
      // a SCENE rebuild only; nothing in this file ever reloads the
      // page. Gated (edit #22): a loss that began inside a fullscreen
      // transition window is the surface swap still settling, so the
      // check re-arms instead of rebuilding; the rebuild only fires
      // when the loss has persisted ≥6s AND the last fullscreen
      // transition is >12s behind us AND the page is visible.
      window.clearTimeout(ctxRebuildTimer);
      const scheduleCtxRebuildCheck = () => {
        ctxRebuildTimer = window.setTimeout(() => {
          if (!glLost) return;
          if (
            document.hidden ||
            performance.now() - lastFsTransitionAt < 12000
          ) {
            scheduleCtxRebuildCheck();
            return;
          }
          setCtxLost(false);
          setMountKey((k) => k + 1);
        }, 6000);
      };
      scheduleCtxRebuildCheck();
    };
    const onCtxRestored = () => {
      glLost = false;
      setCtxLost(false);
      window.clearTimeout(ctxRestoreTimer);
      window.clearTimeout(ctxRebuildTimer);
      try {
        scene.traverse((obj) => {
          const m = (obj as THREE.Mesh).material as
            | THREE.Material
            | THREE.Material[]
            | undefined;
          const mats = Array.isArray(m) ? m : m ? [m] : [];
          for (const mat of mats) {
            const withMap = mat as THREE.MeshBasicMaterial;
            if (withMap.map) withMap.map.needsUpdate = true;
            mat.needsUpdate = true;
          }
        });
        if (earthTexEntry && earthMat.map === earthTexEntry.tex) {
          earthTexEntry.tex.needsUpdate = true;
        }
        if (cloudTexObj) cloudTexObj.needsUpdate = true;
      } catch {
        // Even if the sweep fails, resizing + the next frame re-upload
        // what three.js can; the overlay rebuild covers the rest.
      }
      resize();
    };
    canvasEl.addEventListener("webglcontextlost", onCtxLost);
    canvasEl.addEventListener("webglcontextrestored", onCtxRestored);

    let raf = 0;
    let last = performance.now();
    // Adaptive quality: an EMA of frame time; if it stays above 22ms for
    // a sustained 2s, step resolution down the ladder (2 → 1.5 → 1.25 →
    // 1) and trim the on-screen label budget. It never steps back up, so
    // the picture can't oscillate. Fullscreen caps the ladder at 1.75.
    const PR_STEPS = [2, 1.5, 1.25, 1];
    const LABEL_BUDGETS = [100000, 90, 60, 36];
    let qualityStep = 0;
    let labelBudget = LABEL_BUDGETS[0] ?? 100000;
    let frameAvg = 16;
    let overSince = 0;
    const loopStart = performance.now();
    // Basemap layer currently applied to the earth material (the
    // render loop applies layerRef changes lazily, once the target
    // texture has loaded).
    let appliedLayer: MapLayer | null = null;
    // First-frame signal for App's loading veil + the render-error
    // watchdog state (a sustained run of failing frames rebuilds the
    // scene instead of spinning on a black canvas forever).
    let firstFrameSignalled = false;
    let frameErrors = 0;
    let lastLoopRebuildAt = 0;
    // Collision-avoidance throttle state: placement is only recomputed
    // when the camera actually moved/zoomed (or selection changed, or a
    // 900ms safety tick passed) — a static frame reuses the last result.
    const lastCollideQuat = new THREE.Quaternion().copy(goalQuatRef.current);
    let lastCollideDist = -1;
    let lastCollideAt = 0;
    let lastCollideHover: string | null = null;
    let lastCollideActive: string | null = null;
    let lastCollideProvince: string | null = null;
    let lastCollideRegion: string | null = null;
    let focusCheckAt = 0;
    const invQ = new THREE.Quaternion();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dtMs = now - last;
      last = now;
      if (document.hidden) return;
      if (glLost) return; // context revoked — wait for restore / rebuild
      // Fullscreen-transition grace (edit #22): frames in the ~2.5s
      // after a fullscreen switch run mid-surface-swap and may throw
      // or stall innocently — they never count toward the render
      // watchdog below, so a fullscreen toggle alone can never arm a
      // scene rebuild.
      if (now - lastFsTransitionAt < 2500) frameErrors = 0;
      // Drain queued construction (labels, boundary chunks) a fixed
      // number of jobs per frame so building never freezes interaction
      // (count-based, not clock-based — see drainBuildJobs).
      drainBuildJobs();
      const dt = Math.min(0.05, dtMs / 1000);

      frameAvg = frameAvg * 0.95 + Math.min(dtMs, 100) * 0.05;
      if (now - loopStart > 3000) {
        if (frameAvg > 22) {
          if (overSince === 0) {
            overSince = now;
          } else if (
            now - overSince > 2000 &&
            qualityStep < PR_STEPS.length - 1
          ) {
            qualityStep++;
            overSince = 0;
            const stepCap = PR_STEPS[qualityStep] ?? 1;
            const cap = fsMode ? Math.min(1.75, stepCap) : stepCap;
            if (pixelRatio > cap) {
              pixelRatio = cap;
              renderer.setPixelRatio(pixelRatio);
              resize();
            }
            labelBudget = LABEL_BUDGETS[qualityStep] ?? 36;
            lastCollideAt = 0; // force one re-placement at the new budget
          }
        } else {
          overSince = 0;
        }
      }

      try {
        // Orbit spin (edit #27): advancing the goal longitude rotates
        // the earth about its OWN polar axis — the pole itself never
        // moves, so even a long spin leaves north exactly up. (The
        // old world-Y premultiply rotated about the screen-vertical
        // axis and swung the tilted pole around it.) Rate unchanged:
        // 0.00045 rad per frame; the displayed orientation is set
        // straight onto the goal, as the old code's lockstep
        // premultiply did, and the slerp below is skipped this frame.
        const spinning =
          autoRotateRef.current &&
          !dragging &&
          !reducedMotion &&
          now - lastFocusAtRef.current > 4500;
        if (spinning) {
          const o = goalOrbitRef.current;
          o.lng -= (0.00045 * 180) / Math.PI;
          if (o.lng < -180) o.lng += 360;
          syncGoalFromOrbit();
          group.quaternion.copy(goalQuatRef.current);
        }
        if (!spinning) {
          const alpha = 1 - Math.exp(-dt * 3.2);
          group.quaternion.slerp(goalQuatRef.current, alpha);
        }
        camera.position.z =
          camera.position.z + (goalDistRef.current - camera.position.z) * (1 - Math.exp(-dt * 3));
        const dist = camera.position.z;
        currentDistRef.current = dist;
        saveCam();

        // Dynamic near plane (L5): near tracks altitude — ~35% of
        // the height above the surface, floored at 0.004 — so at
        // the deepest zoom the surface (0.06 away) and the plates
        // riding at r≈1.01–1.03 (0.03–0.05 away) stay in front of
        // the near plane, while at globe distances the near plane
        // sits far out and depth precision for the stacked boundary
        // lines is unchanged. Updated only on a >25% change so the
        // projection matrix isn't rebuilt every frame.
        {
          const wantNear = THREE.MathUtils.clamp((dist - 1) * 0.35, 0.004, 0.3);
          if (Math.abs(camera.near - wantNear) > wantNear * 0.25) {
            camera.near = wantNear;
            camera.updateProjectionMatrix();
          }
        }
        // Atmosphere fade (L5): ease the fresnel halo out as the
        // camera closes below ~1.25 and hide the shell entirely
        // before the camera (floor 1.06) reaches its 1.10 radius —
        // inside an unfaded BackSide shell the whole frame washes
        // blue-white. Zooming back out restores it symmetrically.
        {
          const fade = THREE.MathUtils.clamp((dist - 1.12) / 0.13, 0, 1);
          atmosphereFade.value = fade;
          atmosphere.visible = fade > 0.01;
        }

        // Cloud drift pauses in fullscreen: smoothness wins over motion.
        if (cloudsRef.current && !reducedMotion && !fsMode) {
          cloudsRef.current.quaternion.premultiply(cloudStep);
        }

        // ── v2.0 layers per-frame ──────────────────────────────────
        // Twilight band: the sun uniform tracks the live subsolar
        // point (earth-local coordinates, so the band stays glued to
        // the real terminator as the globe rotates under it). The
        // clock MUST be the real wall clock: `now` in this loop is
        // the requestAnimationFrame timestamp (ms since page
        // navigation), and feeding it to new Date() landed the sun
        // in January 1970 — declination stuck at −23°, terminator on
        // the wrong side of the planet, creeping with page uptime
        // instead of the sun (the user's 「日落是假的」). With
        // Date.now() the band sits on the true terminator and drifts
        // west at the real 15°/hour — slow, exactly as it should.
        {
          const tm = twilightMeshRef.current;
          if (tm) {
            // The band shows for 追霞 — and whenever the time machine
            // is shifted, since the moving terminator IS its subject.
            // Its sun follows the shifted clock in that case.
            tm.visible = twilightOnRef.current || timeShiftRef.current !== 0;
            if (tm.visible && twilightUniformRef.current) {
              const sp = subsolarPoint(
                new Date(Date.now() + timeShiftRef.current * 60000),
              );
              twilightUniformRef.current.value
                .copy(latLngToVec3(sp.lat, sp.lng, 1))
                .normalize();
            }
          }
        }
        // Event-layer icons (quakes + natural events): world size is
        // recomputed EVERY frame from each sprite's own depth — a
        // fixed target screen diameter (px) eased by labelShrink, the
        // same rule the name plates and the selection pin follow.
        // The old fixed WORLD sizes ballooned ~20× on screen as the
        // camera dived to max zoom (and the 128px raster smeared);
        // now the icons hold their size far away and get finer as
        // you zoom in (「图标没有跟随变小」 fix), and quakes keep a
        // gentle pulse on top of the sized diameter.
        {
          const iconShrink = labelShrink(dist);
          if (showQuakesRef.current) {
            for (const s of quakeSpritesRef.current) {
              tmpWorld
                .copy(s.sprite.position)
                .applyQuaternion(group.quaternion);
              const depth = camera.position.distanceTo(tmpWorld);
              const px =
                s.px * iconShrink * (1 + 0.15 * Math.sin(now * 0.004 + s.phase));
              const w =
                (px * 2 * Math.max(0.02, depth) * TAN_HALF_FOV) /
                Math.max(1, viewH);
              s.sprite.scale.set(w, w, 1);
            }
          }
          if (showEventsRef.current) {
            for (const s of eventSpritesRef.current) {
              tmpWorld
                .copy(s.sprite.position)
                .applyQuaternion(group.quaternion);
              const depth = camera.position.distanceTo(tmpWorld);
              const w =
                (s.px * iconShrink * 2 * Math.max(0.02, depth) * TAN_HALF_FOV) /
                Math.max(1, viewH);
              s.sprite.scale.set(w, w, 1);
            }
          }
          // Station markers: wide label sprites (320×96 canvas), so
          // height follows width at the canvas aspect.
          if (showStationsRef.current) {
            for (const s of stationSpritesRef.current) {
              tmpWorld
                .copy(s.sprite.position)
                .applyQuaternion(group.quaternion);
              const depth = camera.position.distanceTo(tmpWorld);
              const w =
                (s.px * iconShrink * 2 * Math.max(0.02, depth) * TAN_HALF_FOV) /
                Math.max(1, viewH);
              s.sprite.scale.set(w, w * (96 / 320), 1);
            }
          }
        }
        // Weather layer off: the city name plates (the weather
        // layer's markers) hide; geography labels stay.
        if (!showWeatherRef.current) {
          for (const recs of cityLabelsRef.current.values()) {
            for (const l of recs) {
              if (l.sprite.visible) {
                l.sprite.visible = false;
                l.mat.opacity = 0;
              }
            }
          }
        }

        const lv = levelFor(dist);
        if (lv !== levelRef.current) {
          levelRef.current = lv;
          callbacksRef.current.onLevelChange(lv);
        }
        // Unlock deeper label tiers as the user zooms toward them.
        if (dist < 2.7) ensureTierLabels(2);
        if (dist < 2.1) ensureTierLabels(3);
        // Twilight band on (user follow-up): the tier-2/3 plates
        // must EXIST even at the global view — band cities show at
        // any zoom — and band membership is refreshed on a 20s tick
        // (the band creeps 0.25°/min, so membership is near-static
        // between ticks). findTwilightCities applies the same
        // evening-band test (altitude −6°…+1°, evening side) the App
        // counts 黄昏城市 with, over the library's size tiers 1–3
        // (特大/大/中型) — nothing smaller is ever force-shown.
        if (twilightOnRef.current) {
          ensureTierLabels(2);
          ensureTierLabels(3);
          if (!bandCitySetRef.current || now - bandCitySetAtRef.current > 20000) {
            bandCitySetRef.current = new Set(
              findTwilightCities(CITIES, new Date()).map((t) => t.city.id),
            );
            bandCitySetAtRef.current = now;
          }
        } else if (bandCitySetRef.current) {
          bandCitySetRef.current = null;
        }

        const pMat = provinceLinesMatRef.current;
        if (pMat) {
          const target = lv >= 2 ? 0.6 : 0;
          pMat.opacity += (target - pMat.opacity) * Math.min(1, dt * 5);
        }

        // Admin_1 (province/state boundaries for ALL countries,
        // geoBoundaries gbOpen — the old Natural Earth asset covered
        // only 8 countries, which is why most of the world showed no
        // subdivisions): lazy-load once the camera first closes in,
        // then fade in below country borders' brightness.
        if (!admin1Requested && dist < 2.78) {
          admin1Requested = true;
          void import("./assets/admin1")
            .then((m) => {
              // Build in slices through the job queue (805 rings is a
              // visible hitch if built in one frame, and this trigger
              // can coincide with a tap's fly-to). All chunks share one
              // material so the opacity fade below drives them as one.
              const mat = new THREE.LineBasicMaterial({
                color: layerRef.current === "simple" ? 0xbcc7cb : 0x9fd4ea,
                transparent: true,
                opacity: 0,
                depthWrite: false,
              });
              admin1Mat = mat;
              const grp = new THREE.Group();
              group.add(grp);
              const rings = m.ADMIN1_RINGS;
              for (let i = 0; i < rings.length; i += 110) {
                const slice = rings.slice(i, i + 110);
                buildJobs.push(() => {
                  const seg = buildLineSegments(
                    slice.map((ring) => ({ rings: [ring] })),
                    1.005,
                    0x9fd4ea,
                    0,
                  );
                  (seg.material as THREE.Material).dispose();
                  seg.material = mat;
                  grp.add(seg);
                });
              }
            })
            .catch(() => {
              // No admin_1 layer — national borders still show.
            });
        }
        if (admin1Mat) {
          const target = dist < 2.78 ? 0.3 : 0;
          admin1Mat.opacity +=
            (target - admin1Mat.opacity) * Math.min(1, dt * 4);
        }

        // Focused-region detection for the deep-zoom admin layers
        // (~5×/s, only near L3): view-centre → China province (DataV
        // prefecture layer) or, anywhere else, the country whose
        // geoBoundaries bbox contains the centre most centrally →
        // that country's ADM2 county boundaries.
        if (now - focusCheckAt > 200) {
          focusCheckAt = now;
          if (dist < 2.66) {
            invQ.copy(group.quaternion).invert();
            tmpDir.set(0, 0, 1).applyQuaternion(invQ);
            const cLat =
              (Math.asin(THREE.MathUtils.clamp(tmpDir.y, -1, 1)) * 180) /
              Math.PI;
            let cLng = (Math.atan2(tmpDir.z, -tmpDir.x) * 180) / Math.PI - 180;
            if (cLng < -180) cLng += 360;
            if (cLng > 180) cLng -= 360;
            // Country containing the view centre: drives BOTH the
            // ADM2 boundary focus (L4 band only) and the ADM1
            // region-name plates (built while zooming, shown from
            // the L2 boundary). Among containing bboxes the winner
            // is the one where the centre sits most CENTRALLY
            // (normalised distance from the bbox centre, smallest
            // area as tiebreak): "smallest bbox wins" mis-focused
            // border cities — Dali (Yunnan) sits at the very edge
            // of Myanmar's bbox (lng fraction 0.90) but well inside
            // China's, and the smallest-area rule picked Myanmar,
            // surrounding a Chinese city with the wrong country's
            // region plates and county boundaries.
            // Antimeridian-spanning bboxes (USA/RUS/FJI span ~360°
            // of longitude via Alaska/Chukotka/territories, so they
            // "contain" most of the planet and their centres land
            // mid-ocean) sit out the centrality contest; they only
            // win as a fallback when no normal bbox contains the
            // point (a Kansas or Siberia view is contained by
            // nothing else).
            let iso: string | null = null;
            let isoScore = Infinity;
            let isoArea = Infinity;
            let fbIso: string | null = null;
            let fbArea = Infinity;
            for (const c of GB_COUNTRIES) {
              const [mnx, mny, mxx, mxy] = c.bbox;
              if (cLng >= mnx && cLng <= mxx && cLat >= mny && cLat <= mxy) {
                const area = (mxx - mnx) * (mxy - mny);
                if (area < fbArea) {
                  fbArea = area;
                  fbIso = c.iso;
                }
                if (mxx - mnx > 180) continue;
                const fx = (cLng - mnx) / Math.max(1e-9, mxx - mnx) - 0.5;
                const fy = (cLat - mny) / Math.max(1e-9, mxy - mny) - 0.5;
                const score = Math.hypot(fx, fy);
                if (
                  score < isoScore - 1e-6 ||
                  (Math.abs(score - isoScore) <= 1e-6 && area < isoArea)
                ) {
                  isoScore = score;
                  isoArea = area;
                  iso = c.iso;
                }
              }
            }
            if (iso == null) iso = fbIso;
            setRegionCountry(iso === "CHN" ? null : iso);
            if (dist < 2.12) {
              let best: string | null = null;
              let bestD = 7;
              if (cLat > 15 && cLat < 55 && cLng > 70 && cLng < 140) {
                const cosLat = Math.cos((cLat * Math.PI) / 180);
                for (const p of PROVINCES) {
                  if (!p.center) continue;
                  const dLat = p.center[1] - cLat;
                  const dLng = (p.center[0] - cLng) * cosLat;
                  const d = Math.hypot(dLat, dLng);
                  if (d < bestD) {
                    bestD = d;
                    best = p.name;
                  }
                }
              }
              setCityAdminProvince(best);
              if (best) {
                setAdmin2Country(null);
              } else if (dist < L4_AT) {
                // County (ADM2) boundaries are L4 content under the
                // strict level discipline — they engage only in the
                // deepest band, not from L3 as before.
                setAdmin2Country(iso === "CHN" ? null : iso);
              } else {
                setAdmin2Country(null);
              }
            } else {
              if (cityAdminProvince !== null) setCityAdminProvince(null);
              if (admin2Iso !== null) setAdmin2Country(null);
            }
          } else {
            if (cityAdminProvince !== null) setCityAdminProvince(null);
            if (admin2Iso !== null) setAdmin2Country(null);
            if (regionCountryIso !== null) setRegionCountry(null);
          }
        }
        if (cityAdminMat) {
          // Prefecture boundaries are L3 content (plates gate at L3;
          // the lines may start their fade a hair earlier, at build
          // range, so they are ready when the level arrives).
          const target = dist < 2.12 && cityAdminProvince ? 0.5 : 0;
          cityAdminMat.opacity +=
            (target - cityAdminMat.opacity) * Math.min(1, dt * 4);
        }
        if (admin2Mat) {
          // County boundaries fade in only inside the L4 band.
          const target = dist < L4_AT && admin2Iso ? 0.42 : 0;
          admin2Mat.opacity +=
            (target - admin2Mat.opacity) * Math.min(1, dt * 4);
        }

        // Basemap layer application: when the layer prop changes,
        // load the target texture on demand (single-residency rule:
        // see loadLayerTex above), re-point the earth material at it
        // the frame it is ready, DISPOSE the previous layer's
        // texture at that swap, and restyle the overlays for it —
        // boundary tint, label tint (dark on the light simple map),
        // specular, and the cloud policy (satellite and simple show
        // NO cloud layer: its blocky alpha mask was the ocean mosaic;
        // terrain keeps a faint drift). Until the target is ready
        // the current texture keeps painting — no black flash.
        if (appliedLayer !== layerRef.current) {
          const want = layerRef.current;
          if (!earthTexEntry || earthTexEntry.layer !== want) {
            // A switch is pending and its texture isn't the resident
            // one: start (or restart) its load. If a different
            // pending load was in flight for a layer the user has
            // already switched away from, dispose it unused.
            if (earthTexEntry && appliedLayer !== earthTexEntry.layer) {
              earthTexEntry.tex.dispose();
            }
            earthTexEntry = loadLayerTex(want);
          }
          const entry = earthTexEntry;
          if (entry.ready) {
            appliedLayer = want;
            const prevTex =
              earthMat.map && earthMat.map !== entry.tex
                ? earthMat.map
                : null;
            earthMat.map = entry.tex;
            earthMat.needsUpdate = true;
            // Single residency: the previous layer's GPU texture is
            // released at the swap; revisiting that layer reloads it.
            if (prevTex) prevTex.dispose();
            earthMat.specular.setHex(
              want === "simple" ? 0x000000 : want === "terrain" ? 0x0a141f : 0x1a2a38,
            );
            earthMat.shininess = want === "satellite" ? 8 : want === "terrain" ? 4 : 0;
            if (want === "terrain") ensureCloudTex();
            clouds.visible = want === "terrain" && cloudTexReady;
            (clouds.material as THREE.MeshLambertMaterial).opacity = 0.16;
            // Simple layer: boundary lines go light grey and quiet —
            // WebGL lines are 1px at minimum, so "thinner" is done as
            // paler colour + lower opacity (the redesigned basemap
            // already bakes matching light-grey hairlines in).
            bordersMat.color.setHex(want === "simple" ? 0xb4bfc4 : 0xeaf6ff);
            bordersMat.opacity = want === "simple" ? 0.38 : 0.36;
            if (pMat) pMat.color.setHex(want === "simple" ? 0xbcc7cb : 0xbfe6ff);
            if (admin1Mat) admin1Mat.color.setHex(want === "simple" ? 0xbcc7cb : 0x9fd4ea);
            if (cityAdminMat) cityAdminMat.color.setHex(want === "simple" ? 0xb4bfc4 : 0xd6f0ff);
            if (admin2Mat) admin2Mat.color.setHex(want === "simple" ? 0xb4bfc4 : 0xd6f0ff);
            applyLabelTint(want === "simple" ? 0x2a3a46 : 0xffffff);
          }
        }
        // Clouds at L5 depth: the cloud shell rides at r=1.014 —
        // centimetres from the L5 camera (floor 1.06) its soft
        // alpha blobs would fill the frame as milky patches. The
        // layer policy above owns visibility per basemap; this line
        // additionally gates it by depth, every frame, so clouds
        // exist only on the terrain layer AND above L5 approach.
        clouds.visible =
          appliedLayer === "terrain" && dist >= 1.22 && cloudTexReady;

        // Selection fallback dot sizing: a constant ~11 screen pixels
        // at any zoom (same screen-space rule as the name plates) —
        // never the screen-filling ring the old pin became at depth.
        const dotS = selDotRef.current;
        if (dotS && dotS.visible) {
          tmpWorld.copy(dotS.position).applyQuaternion(group.quaternion);
          const dotDepth = camera.position.distanceTo(tmpWorld);
          const ds =
            (11 * 2 * Math.max(0.02, dotDepth) * TAN_HALF_FOV) /
            Math.max(1, viewH);
          dotS.scale.set(ds, ds, 1);
        }

        // Labels: country (L1), provinces (L2+), cities (by label tier).
        // EVERY label's world height is recomputed from the live
        // distance as dist × K(tier) × labelShrink(dist): on screen the
        // names hold roughly steady far away and get finer as the
        // camera dives, instead of the old behaviour (a growth boost
        // for cities, fixed world size for province/prefecture plates)
        // that left max-zoom names as big as — or bigger than — the
        // L1 ones. Survivors of the tier/facing gates go through
        // screen-space collision avoidance before anything is shown.
        // Throttle: only re-run placement when the camera moved/zoomed,
        // the hovered/active city changed, or the 900ms safety tick hit.
        const needCollide =
          lastCollideQuat.angleTo(group.quaternion) > 0.0012 ||
          Math.abs(dist - lastCollideDist) > 0.004 ||
          hoverIdRef.current !== lastCollideHover ||
          activeIdRef.current !== lastCollideActive ||
          cityAdminProvince !== lastCollideProvince ||
          regionCountryIso !== lastCollideRegion ||
          now - lastCollideAt > 900;
        if (needCollide) {
        const shrink = labelShrink(dist);
        candCount = 0;
        const collectLabels = (
          recs: LabelRec[],
          zoom: number,
          strictFacing: boolean,
          prioBonus = 0,
          band: Set<string> | null = null,
        ) => {
          for (const l of recs) {
            const inBand =
              band != null && l.cityId != null && band.has(l.cityId);
            if (l.cityId != null) {
              // Sunset-band plates wear a warm tint so the reader
              // can pick out the cities the band is lighting up from
              // the regular plates; every other city plate (re)takes
              // the basemap tint. This runs on every placement pass,
              // so a band toggle or a basemap switch self-heals
              // within a frame or two.
              l.mat.color.setHex(inBand ? 0xffb066 : currentLabelTint);
            }
            tmpDir.copy(l.dir).applyQuaternion(group.quaternion);
            const facing = tmpDir.dot(camDir);
            const lo = strictFacing ? 0.3 : 0.12;
            const hi = strictFacing ? 0.62 : 0.42;
            const faceFade = THREE.MathUtils.clamp((facing - lo) / (hi - lo), 0, 1);
            // Band cities bypass the zoom tier gate: full strength
            // at any camera distance (facing fade still applies).
            const op = (inBand ? Math.max(zoom, 1) : zoom) * faceFade * 0.95;
            if (op <= 0.02) {
              l.mat.opacity = 0;
              l.sprite.visible = false;
              continue;
            }
            // Size from the plate's OWN depth (computed first, below):
            // perspective divides by depth, not by the camera's
            // distance to the origin — at max zoom depth ≈ dist − 1
            // is ~7× smaller than dist, so v14's dist-based height
            // ballooned on screen. plateWorldHeight inverts the
            // projection to the tier's fixed ink pixels, with the
            // untouched v14 expression as its fallback.
            tmpWorld.copy(l.dir).applyQuaternion(group.quaternion).multiplyScalar(l.radius);
            const depth = camera.position.distanceTo(tmpWorld);
            const h = plateWorldHeight(
              depth,
              l.tier,
              l.textHFrac,
              dist * 0.0305 * (TIER_LABEL_K[l.tier] ?? 1) * shrink,
            );
            l.sprite.scale.set(h * l.aspect, h, 1);
            // Long-name width cap: a very long plate (a full region
            // name) must not span the whole view — shrink it toward
            // a 62%-of-view / 560px cap, but never below a ~10px
            // glyph height, so the name stays complete AND readable.
            {
              const pxPerWorld0 =
                viewH / (2 * Math.max(0.02, depth) * TAN_HALF_FOV);
              const inkWpx = l.sprite.scale.x * pxPerWorld0 * l.textFrac;
              const capW = Math.min(viewW * 0.62, 560);
              if (inkWpx > capW) {
                const floorS = 10 / (LABEL_INK_PX[l.tier] ?? 13);
                const s = Math.max(capW / inkWpx, Math.min(1, floorS));
                if (s < 1) l.sprite.scale.multiplyScalar(s);
              }
            }
            // Project the plate centre to screen pixels and size its
            // rect from the sprite's world scale at its true depth.
            tmpWorld.project(camera);
            if (tmpWorld.z > 1 || tmpWorld.z < -1) {
              l.mat.opacity = 0;
              l.sprite.visible = false;
              continue;
            }
            const pxPerWorld = viewH / (2 * Math.max(0.02, depth) * TAN_HALF_FOV);
            let cand = candPool[candCount];
            if (!cand) {
              cand = { rec: l, op: 0, x: 0, y: 0, hw: 0, hh: 0, prio: 0 };
              candPool[candCount] = cand;
            }
            cand.rec = l;
            cand.op = op;
            cand.x = (tmpWorld.x * 0.5 + 0.5) * viewW;
            cand.y = (-tmpWorld.y * 0.5 + 0.5) * viewH;
            cand.hw = ((l.sprite.scale.x * pxPerWorld) / 2) * l.textFrac + LABEL_PAD_X;
            cand.hh = ((l.sprite.scale.y * pxPerWorld) / 2) * l.textHFrac + LABEL_PAD_Y;
            cand.prio =
              l.priority +
              prioBonus +
              (inBand ? 260 : 0) +
              (l.cityId != null && l.cityId === activeIdRef.current
                ? 10000
                : l.cityId != null && l.cityId === hoverIdRef.current
                  ? 500
                  : 0);
            candCount++;
          }
        };
        const countryZoom = THREE.MathUtils.clamp((3.35 - dist) / 0.85, 0, 1);
        const countryOut = THREE.MathUtils.clamp((dist - 1.98) / 0.3, 0, 1);
        // Country names are the headline of the L1 global view (the
        // user's rule: L1 shows country names + megacities) — at base
        // priority 30 they lost every collision against tier-1 cities
        // in dense views and vanished entirely (中国 blocked by its
        // own cities). In the L1 band they place FIRST; from L2 down
        // the bonus drops away and they yield to provinces/regions
        // while countryOut fades them out through L3.
        collectLabels(
          countryLabels,
          countryZoom * countryOut,
          false,
          dist >= L2_AT ? 200 : 0,
        );
        const provZoom = THREE.MathUtils.clamp((2.42 - dist) / 0.35, 0, 1);
        collectLabels(provinceLabelsRef.current, provZoom, false);
        if (cityAdminLabels.length > 0) {
          // Prefecture names are L3 content: the gate opens at the
          // L3 boundary (the layer itself builds a touch earlier, at
          // 2.12, so the plates are ready when the level arrives).
          const cityZoom = THREE.MathUtils.clamp((L3_AT - dist) / 0.25, 0, 1);
          // Centre-first among equals: all prefecture plates share
          // priority 110 and the placement sort is stable, so raw
          // data order would let an edge prefecture (Baoshan) block
          // the one the user actually flew to (Dali). Sorting by
          // facing makes the view's subject place first — the same
          // rule the region pass uses.
          cityAdminLabels.sort((a, b) => {
            const fa = tmpDir.copy(a.dir).applyQuaternion(group.quaternion).dot(camDir);
            const fb = tmpDir.copy(b.dir).applyQuaternion(group.quaternion).dot(camDir);
            return fb - fa;
          });
          collectLabels(cityAdminLabels, cityZoom, false);
        }
        if (showWeatherRef.current) {
          for (const tier of [1, 2, 3]) {
            const recs = cityLabelsRef.current.get(tier);
            if (recs && recs.length > 0) {
              collectLabels(
                recs,
                labelGate(tier, dist),
                true,
                0,
                bandCitySetRef.current,
              );
            }
          }
        }
        // Greedy placement, highest priority first: a plate that would
        // overlap an already-placed one is hidden for this frame (its
        // city name stays readable) — clusters thin out instead of
        // stacking into an unreadable smear.
        candOrder.length = candCount;
        for (let i = 0; i < candCount; i++) {
          const c = candPool[i];
          if (c) candOrder[i] = c;
        }
        candOrder.sort((a, b) => b.prio - a.prio);
        winners.length = 0;
        // Two-pass placement: the level's HEADLINE plates place
        // first — admin names (country / province / prefecture:
        // cityId null) and top cities (prio ≥ 85) — then ordinary
        // cities fill the remaining budget. A single prio-sorted
        // pass starved whole layers on capped budgets: at deep
        // zoom the facing hemisphere holds 150+ city candidates
        // with prio ≥ 100 numbering 30+, so a 36-plate budget was
        // exhausted before any 90-prio prefecture plate placed
        // (measured at Dali: 16 candidates, ~0 placed).
        const placeCand = (cand: LabelCand) => {
          if (winners.length >= labelBudget) {
            cand.rec.mat.opacity = 0;
            cand.rec.sprite.visible = false;
            return;
          }
          // Same-name dedupe, unified across ALL plate sources:
          // when two layers name the SAME place (a DataV province
          // plate 北京 vs the Beijing city plate, a prefecture plate
          // vs its library city), the anchors can sit well over
          // 100px apart at wide zoom — too far for rect collision to
          // merge, close enough to read as a doubled name. Within
          // the band's capture radius (dedupeRadiusPx — widest at
          // L1/L2, where the report came from) the lower-priority
          // plate is hidden; placement is priority-ordered, so any
          // same-named winner outranks this candidate. Matching uses
          // platesNameSamePlace (exact + English alt + normalised
          // containment), not raw string equality.
          const dedupeR = dedupeRadiusPx(dist);
          for (const w of winners) {
            if (
              platesNameSamePlace(
                cand.rec.name,
                cand.rec.altName,
                w.rec.name,
                w.rec.altName,
              ) &&
              Math.hypot(cand.x - w.x, cand.y - w.y) < dedupeR
            ) {
              cand.rec.mat.opacity = 0;
              cand.rec.sprite.visible = false;
              return;
            }
          }
          let blocked = false;
          for (const w of winners) {
            if (
              Math.abs(cand.x - w.x) < cand.hw + w.hw &&
              Math.abs(cand.y - w.y) < cand.hh + w.hh
            ) {
              blocked = true;
              break;
            }
          }
          if (blocked) {
            cand.rec.mat.opacity = 0;
            cand.rec.sprite.visible = false;
          } else {
            winners.push(cand);
            cand.rec.mat.opacity = cand.op;
            cand.rec.sprite.visible = true;
          }
        };
        for (const cand of candOrder) {
          if (cand.rec.cityId == null || cand.prio >= 85) placeCand(cand);
        }
        for (const cand of candOrder) {
          if (cand.rec.cityId != null && cand.prio < 85) placeCand(cand);
        }
        lastCollideQuat.copy(group.quaternion);
        lastCollideDist = dist;
        lastCollideHover = hoverIdRef.current;
        lastCollideActive = activeIdRef.current;
        lastCollideProvince = cityAdminProvince;
        lastCollideRegion = regionCountryIso;
        lastCollideAt = now;
        }

        // ADM1 region name plates get a DEDICATED pass, deliberately
        // outside the pooled collision system above, in two parts:
        // (1) opacity/scale are driven here directly (gate × facing,
        // the same scale rule as every other label) — the pooled
        // placement starved this layer entirely in throttled
        // contexts, so the layer does not depend on it; (2) the
        // plates ARE thinned — against the pooled winners and each
        // other: dataset representative points can crowd (Normandie
        // / Île-de-France / Centre-Val de Loire around Paris) and
        // unthinned they stack into an unreadable smear. Most-facing
        // plates win; as the camera dives the points separate on
        // screen and the hidden names return. STRICT level gate:
        // region names are L2 content — they open exactly at the
        // L2 boundary and never show in the global view.
        if (regionLabels.length > 0) {
          const rZoom = gate(dist, L2_AT, 2.14);
          const rShrink = labelShrink(dist);
          let rCount = 0;
          for (const l of regionLabels) {
            tmpDir.copy(l.dir).applyQuaternion(group.quaternion);
            const facing = tmpDir.dot(camDir);
            const faceFade = THREE.MathUtils.clamp(
              (facing - 0.12) / 0.3,
              0,
              1,
            );
            const op = rZoom * faceFade * 0.95;
            if (op <= 0.02) {
              l.mat.opacity = 0;
              l.sprite.visible = false;
              continue;
            }
            tmpWorld
              .copy(l.dir)
              .applyQuaternion(group.quaternion)
              .multiplyScalar(l.radius);
            const depth = camera.position.distanceTo(tmpWorld);
            // Same screen-space rule as the pooled pass: size from
            // the plate's own depth to its fixed ink pixels (tier 7
            // → 13px), v14 expression as fallback.
            const h = plateWorldHeight(
              depth,
              l.tier,
              l.textHFrac,
              dist * 0.0305 * (TIER_LABEL_K[l.tier] ?? 1) * rShrink,
            );
            l.sprite.scale.set(h * l.aspect, h, 1);
            // Same long-name width cap as the pooled pass.
            {
              const pxPerWorld0 =
                viewH / (2 * Math.max(0.02, depth) * TAN_HALF_FOV);
              const inkWpx = l.sprite.scale.x * pxPerWorld0 * l.textFrac;
              const capW = Math.min(viewW * 0.62, 560);
              if (inkWpx > capW) {
                const floorS = 10 / (LABEL_INK_PX[l.tier] ?? 13);
                const s = Math.max(capW / inkWpx, Math.min(1, floorS));
                if (s < 1) l.sprite.scale.multiplyScalar(s);
              }
            }
            tmpWorld.project(camera);
            if (tmpWorld.z > 1 || tmpWorld.z < -1) {
              l.mat.opacity = 0;
              l.sprite.visible = false;
              continue;
            }
            const pxPerWorld =
              viewH / (2 * Math.max(0.02, depth) * TAN_HALF_FOV);
            let rc = regionPool[rCount];
            if (!rc) {
              rc = { rec: l, op: 0, x: 0, y: 0, hw: 0, hh: 0, facing: 0 };
              regionPool[rCount] = rc;
            }
            rc.rec = l;
            rc.op = op;
            rc.x = (tmpWorld.x * 0.5 + 0.5) * viewW;
            rc.y = (-tmpWorld.y * 0.5 + 0.5) * viewH;
            rc.hw = ((l.sprite.scale.x * pxPerWorld) / 2) * l.textFrac + LABEL_PAD_X;
            rc.hh = ((l.sprite.scale.y * pxPerWorld) / 2) * l.textHFrac + LABEL_PAD_Y;
            rc.facing = facing;
            rCount++;
          }
          regionOrder.length = rCount;
          for (let i = 0; i < rCount; i++) {
            const c = regionPool[i];
            if (c) regionOrder[i] = c;
          }
          regionOrder.sort((a, b) => b.facing - a.facing);
          regionPlaced.length = 0;
          // Region names are the headline of their level (priority
          // 85): only STRONGER pooled winners block them — tier-1
          // cities (100/120), tier-2 capitals (100), the hovered /
          // active city. Weaker winners (tier-2/3 locals) don't
          // block; instead a placed region plate EVICTS the weaker
          // city plates it overlaps. Strict all-vs-all non-overlap
          // starved this layer completely: a region's representative
          // point always sits among its own cities, so on a phone-
          // width screen every one of the 13 French plates lost to
          // some local city (measured rc=13, rs=0). Google makes the
          // same trade: at region zoom the region name wins its
          // area and the small towns reappear deeper.
          for (const w of winners) {
            if (w.prio > 85) regionPlaced.push(w);
          }
          let regionIdx = 0;
          for (const c of regionOrder) {
            // The region at the centre of the view is the SUBJECT of
            // this zoom level: it always places, evicting whatever
            // city plate it overlaps (measured: Bretagne's ink box
            // genuinely overlaps Paris's on a 390px screen at region
            // zoom — strict non-overlap hid the very region the user
            // flew to). Every other region follows the normal rule.
            const isSubject = regionIdx === 0;
            regionIdx++;
            // Same-name dedupe against the pooled winners — the
            // SAME unified rule as the pooled pass (platesNameSamePlace
            // + the band's capture radius), not a separate 90px
            // exact-match check: a region plate naming a place a
            // visible city plate already names is that place named
            // twice ("Delhi" vs "New Delhi", "Jakarta Special
            // Capital Region" vs "Jakarta", "Singapore" via the
            // city's English name). The region yields; even the
            // subject rule does not resurrect a duplicate.
            let dupName = false;
            const regionDedupeR = dedupeRadiusPx(dist);
            for (const w of winners) {
              if (!w.rec.sprite.visible) continue;
              if (
                platesNameSamePlace(
                  c.rec.name,
                  c.rec.altName,
                  w.rec.name,
                  w.rec.altName,
                ) &&
                Math.hypot(c.x - w.x, c.y - w.y) < regionDedupeR
              ) {
                dupName = true;
                break;
              }
            }
            // Also dedupe against region plates already placed in
            // this pass (two ADM1 rows can name the same metro area
            // in variant forms).
            if (!dupName) {
              for (const p of regionPlaced) {
                const pr = (p as unknown as { rec?: LabelRec }).rec;
                if (!pr || pr === c.rec) continue;
                if (
                  platesNameSamePlace(
                    c.rec.name,
                    c.rec.altName,
                    pr.name,
                    pr.altName,
                  ) &&
                  Math.hypot(c.x - p.x, c.y - p.y) < regionDedupeR
                ) {
                  dupName = true;
                  break;
                }
              }
            }
            if (dupName) {
              c.rec.mat.opacity = 0;
              c.rec.sprite.visible = false;
              continue;
            }
            let blocked = false;
            if (!isSubject) {
              for (const w of regionPlaced) {
                if (
                  Math.abs(c.x - w.x) < c.hw + w.hw &&
                  Math.abs(c.y - w.y) < c.hh + w.hh
                ) {
                  blocked = true;
                  break;
                }
              }
            }
            if (blocked) {
              c.rec.mat.opacity = 0;
              c.rec.sprite.visible = false;
            } else {
              regionPlaced.push(c);
              c.rec.mat.opacity = c.op;
              c.rec.sprite.visible = true;
              for (const w of winners) {
                if (
                  (isSubject || w.prio <= 85) &&
                  w.rec.sprite.visible &&
                  Math.abs(c.x - w.x) < c.hw + w.hw &&
                  Math.abs(c.y - w.y) < c.hh + w.hh
                ) {
                  w.rec.mat.opacity = 0;
                  w.rec.sprite.visible = false;
                  if (isSubject) {
                    const ri = regionPlaced.indexOf(
                      w as unknown as RegionCand,
                    );
                    if (ri >= 0) regionPlaced.splice(ri, 1);
                  }
                }
              }
            }
          }
        }

        // Flight-icon shader uniforms track the live drawing
        // buffer (fullscreen toggles change the pixel ratio).
        const fmat = flightPoints.material as THREE.ShaderMaterial;
        if (fmat.uniforms.uPixelRatio) {
          fmat.uniforms.uPixelRatio.value = pixelRatio;
        }
        if (fmat.uniforms.uAspect) {
          fmat.uniforms.uAspect.value = camera.aspect;
        }
        const smat = shipPoints.material as THREE.ShaderMaterial;
        if (smat.uniforms.uPixelRatio) {
          smat.uniforms.uPixelRatio.value = pixelRatio;
        }
        if (smat.uniforms.uAspect) {
          smat.uniforms.uAspect.value = camera.aspect;
        }
        const wmat = webcamPoints.material as THREE.ShaderMaterial;
        if (wmat.uniforms.uPixelRatio) {
          wmat.uniforms.uPixelRatio.value = pixelRatio;
        }
        if (wmat.uniforms.uAspect) {
          wmat.uniforms.uAspect.value = camera.aspect;
        }

        renderer.render(scene, camera);
        frameErrors = 0;
        if (!firstFrameSignalled) {
          firstFrameSignalled = true;
          callbacksRef.current.onFirstFrame?.();
        }
      } catch {
        // Keep the loop alive through transient render errors — but
        // never spin forever on a black canvas: a sustained run of
        // failing frames (never observed in the probe, but exactly
        // the shape of the on-device "black screen, spinner, never
        // recovers" report) rebuilds the scene, at most once per 20s,
        // the same recovery the context-loss path uses. This is a
        // SCENE rebuild (mountKey remount of the WebGL scene), never
        // a page reload — and it is gated (edit #22) to sustained
        // failures well clear of any fullscreen transition (>15s
        // after the last one), so neither a gesture nor a fullscreen
        // switch can ever trigger it.
        if (now - lastFsTransitionAt > 2500) frameErrors++;
        if (frameErrors > 90) {
          frameErrors = 0;
          if (
            now - lastLoopRebuildAt > 20000 &&
            now - lastFsTransitionAt > 15000
          ) {
            lastLoopRebuildAt = now;
            setMountKey((k) => k + 1);
          }
        }
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.clearTimeout(fsSettleTimer);
      window.clearTimeout(ctxRestoreTimer);
      window.clearTimeout(ctxRebuildTimer);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      if (fsSyncRef.current === syncFsPerf) fsSyncRef.current = null;
      canvasEl.removeEventListener("webglcontextlost", onCtxLost);
      canvasEl.removeEventListener("webglcontextrestored", onCtxRestored);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      mount.removeEventListener("touchmove", blockTouchScroll);
      renderer.dispose();
      if (el.parentElement === mount) mount.removeChild(el);
      markersGroupRef.current = null;
      groupRef.current = null;
    };
  }, [mountKey]);

  // ── v2.0 layer builders (props → scene objects) ──────────────────
  // Each builder fully rebuilds its group from the current props:
  // the datasets are small (≤200 quakes, ≤300 events), so rebuild-on-
  // change beats incremental diffing, and a scene rebuild (mountKey)
  // re-runs them against the fresh groups.
  useEffect(() => {
    const grp = quakeGroupRef.current;
    if (!grp) return;
    for (const child of [...grp.children]) {
      grp.remove(child);
      const s = child as THREE.Sprite;
      s.material.map?.dispose();
      s.material.dispose();
    }
    quakeSpritesRef.current = [];
    quakePicksRef.current = [];
    grp.visible = showQuakes && quakes.length > 0;
    if (!showQuakes) return;
    const texByColor = new Map<string, THREE.Texture>();
    const sprites: Array<{ sprite: THREE.Sprite; px: number; phase: number }> = [];
    const picks: Array<{ q: GlobeQuake; dir: THREE.Vector3 }> = [];
    for (const q of quakes) {
      const color = quakeColor(q.mag);
      let tex = texByColor.get(color);
      if (!tex) {
        tex = quakeTexture(color);
        texByColor.set(color, tex);
      }
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const p = latLngToVec3(q.lat, q.lng, 1.03);
      sprite.position.copy(p);
      // Target on-screen diameter (px at shrink 1), graded by
      // magnitude; the render loop turns it into a world size from
      // the sprite's live depth. The initial scale is a placeholder
      // the first frame overwrites.
      const px = 20 + Math.max(0, q.mag - 4.5) * 8;
      sprite.scale.set(0.06, 0.06, 1);
      sprite.renderOrder = 4;
      grp.add(sprite);
      sprites.push({ sprite, px, phase: (q.time % 6283) / 1000 });
      picks.push({ q, dir: p.clone().normalize() });
    }
    quakeSpritesRef.current = sprites;
    quakePicksRef.current = picks;
  }, [quakes, showQuakes, mountKey]);

  useEffect(() => {
    const grp = eventGroupRef.current;
    if (!grp) return;
    for (const child of [...grp.children]) {
      grp.remove(child);
      const s = child as THREE.Sprite;
      s.material.map?.dispose();
      s.material.dispose();
    }
    eventPicksRef.current = [];
    eventSpritesRef.current = [];
    grp.visible = showEvents && events.length > 0;
    if (!showEvents) return;
    const texByCat = new Map<string, THREE.Texture>();
    const picks: Array<{ e: GlobeEvent; dir: THREE.Vector3 }> = [];
    const sprites: Array<{ sprite: THREE.Sprite; px: number }> = [];
    for (const e of events) {
      let tex = texByCat.get(e.category);
      if (!tex) {
        tex = eventTexture(e.category);
        texByCat.set(e.category, tex);
      }
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const p = latLngToVec3(e.lat, e.lng, 1.032);
      sprite.position.copy(p);
      // Placeholder scale — the render loop sizes every icon from
      // its own depth each frame (30px target at shrink 1).
      sprite.scale.set(0.06, 0.06, 1);
      sprite.renderOrder = 4;
      grp.add(sprite);
      sprites.push({ sprite, px: 30 });
      picks.push({ e, dir: p.clone().normalize() });
    }
    eventPicksRef.current = picks;
    eventSpritesRef.current = sprites;
  }, [events, showEvents, mountKey]);

  // ── v3.0 layer builders ──────────────────────────────────────────
  useEffect(() => {
    const mesh = auroraMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (!auroraOn || !auroraFrame?.canvas) {
      mesh.visible = false;
      return;
    }
    const tex = new THREE.CanvasTexture(auroraFrame.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const old = mat.map;
    mat.map = tex;
    mat.needsUpdate = true;
    if (old) old.dispose();
    mesh.visible = true;
  }, [auroraFrame, auroraOn, mountKey]);

  useEffect(() => {
    const grp = stationGroupRef.current;
    if (!grp) return;
    for (const child of [...grp.children]) {
      grp.remove(child);
      const anyObj = child as unknown as {
        material?: THREE.Material & { map?: THREE.Texture | null };
        geometry?: THREE.BufferGeometry;
      };
      anyObj.material?.map?.dispose();
      anyObj.material?.dispose();
      anyObj.geometry?.dispose();
    }
    stationSpritesRef.current = [];
    stationPicksRef.current = [];
    grp.visible = showStations && stations.length > 0;
    if (!showStations) return;
    const sprites: Array<{ sprite: THREE.Sprite; px: number }> = [];
    const picks: Array<{ s: GlobeStation; dir: THREE.Vector3 }> = [];
    for (const s of stations) {
      const color = s.id === "css" ? "#fda4af" : "#7dd3fc";
      const short = s.id === "css" ? "天宫 CSS" : "ISS";
      const mat = new THREE.SpriteMaterial({
        map: stationTexture(short, color),
        transparent: true,
        opacity: 0.98,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const p = latLngToVec3(s.lat, s.lng, 1.045);
      sprite.position.copy(p);
      sprite.scale.set(0.09, 0.027, 1);
      sprite.renderOrder = 5;
      grp.add(sprite);
      sprites.push({ sprite, px: 92 });
      picks.push({ s, dir: p.clone().normalize() });
      // Ground track: consecutive-point segments, split wherever the
      // track wraps the antimeridian (a segment across the map seam
      // would slash a line through the whole globe).
      const pts: number[] = [];
      for (let i = 0; i + 1 < s.track.length; i++) {
        const a = s.track[i];
        const b = s.track[i + 1];
        if (!a || !b) continue;
        if (Math.abs(a[0] - b[0]) > 180) continue;
        const va = latLngToVec3(a[1], a[0], 1.038);
        const vb = latLngToVec3(b[1], b[0], 1.038);
        pts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      }
      if (pts.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(pts, 3),
        );
        const line = new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        line.renderOrder = 3;
        grp.add(line);
      }
    }
    stationSpritesRef.current = sprites;
    stationPicksRef.current = picks;
  }, [stations, showStations, mountKey]);

  useEffect(() => {
    const ptsObj = flightPointsRef.current;
    if (!ptsObj) return;
    flightPicksRef.current = [];
    if (!showFlights || flights.length === 0) {
      ptsObj.visible = false;
      ptsObj.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([], 3),
      );
      return;
    }
    const arr = new Float32Array(flights.length * 3);
    const kindArr = new Float32Array(flights.length);
    const headArr = new Float32Array(flights.length);
    const colorArr = new Float32Array(flights.length * 3);
    const sizeArr = new Float32Array(flights.length);
    const picks: Array<{ f: GlobeFlight; dir: THREE.Vector3 }> = [];
    flights.forEach((f, i) => {
      const v = latLngToVec3(f.lat, f.lng, 1.03);
      arr[i * 3] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
      kindArr[i] = FLIGHT_KIND_INDEX[f.kind] ?? 0;
      headArr[i] = ((f.heading ?? 0) * Math.PI) / 180;
      // Per-class tint + size: airliners ice-cyan paper planes,
      // business jets lavender (a premium hue kept clear of the
      // rejected yellow family), propeller aircraft coral (inherits
      // the old light-aircraft tint from edit #35), helicopters
      // spring green.
      const tint =
        f.kind === "heli"
          ? [0.45, 0.95, 0.55]
          : f.kind === "prop"
            ? [1.0, 0.5, 0.38]
            : f.kind === "bizjet"
              ? [0.78, 0.64, 1.0]
              : [0.78, 0.94, 1.0];
      colorArr[i * 3] = tint[0] ?? 1;
      colorArr[i * 3 + 1] = tint[1] ?? 1;
      colorArr[i * 3 + 2] = tint[2] ?? 1;
      sizeArr[i] =
        f.kind === "airliner"
          ? 17
          : f.kind === "heli"
            ? 18
            : f.kind === "bizjet"
              ? 15
              : 14;
      picks.push({ f, dir: v.clone().normalize() });
    });
    ptsObj.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(arr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aKind",
      new THREE.BufferAttribute(kindArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aHeading",
      new THREE.BufferAttribute(headArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aColor",
      new THREE.BufferAttribute(colorArr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(sizeArr, 1),
    );
    ptsObj.geometry.computeBoundingSphere();
    ptsObj.visible = true;
    flightPicksRef.current = picks;
  }, [flights, showFlights, mountKey]);

  // Ship layer effect: the flight cloud's twin — one Points draw
  // call, per-class atlas cell + tint + size, glyphs rotated to the
  // vessel's course over ground (falling back to its gyro heading,
  // then north). Ships ride slightly lower than flights (r=1.024 vs
  // 1.03): they sit ON the water the overlays draw.
  useEffect(() => {
    const ptsObj = shipPointsRef.current;
    if (!ptsObj) return;
    shipPicksRef.current = [];
    if (!showShips || ships.length === 0) {
      ptsObj.visible = false;
      ptsObj.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([], 3),
      );
      return;
    }
    const arr = new Float32Array(ships.length * 3);
    const kindArr = new Float32Array(ships.length);
    const headArr = new Float32Array(ships.length);
    const colorArr = new Float32Array(ships.length * 3);
    const sizeArr = new Float32Array(ships.length);
    const picks: Array<{ s: GlobeShip; dir: THREE.Vector3 }> = [];
    ships.forEach((s, i) => {
      const v = latLngToVec3(s.lat, s.lng, 1.024);
      arr[i * 3] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
      kindArr[i] = SHIP_KIND_INDEX[s.kind] ?? 4;
      headArr[i] = (((s.cog ?? s.heading ?? 0) % 360) * Math.PI) / 180;
      // Sea palette, kept apart from the flight classes: cargo ice
      // blue, tanker teal, passenger near-white, fishing light
      // green, other grey-blue.
      const tint =
        s.kind === "tanker"
          ? [0.45, 0.95, 0.8]
          : s.kind === "passenger"
            ? [0.92, 0.97, 1.0]
            : s.kind === "fishing"
              ? [0.68, 1.0, 0.62]
              : s.kind === "other"
                ? [0.72, 0.8, 0.9]
                : [0.62, 0.87, 1.0];
      colorArr[i * 3] = tint[0] ?? 1;
      colorArr[i * 3 + 1] = tint[1] ?? 1;
      colorArr[i * 3 + 2] = tint[2] ?? 1;
      sizeArr[i] =
        s.kind === "cargo" || s.kind === "tanker"
          ? 18
          : s.kind === "passenger"
            ? 16
            : s.kind === "fishing"
              ? 13
              : 14;
      picks.push({ s, dir: v.clone().normalize() });
    });
    ptsObj.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(arr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aKind",
      new THREE.BufferAttribute(kindArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aHeading",
      new THREE.BufferAttribute(headArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aColor",
      new THREE.BufferAttribute(colorArr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(sizeArr, 1),
    );
    ptsObj.geometry.computeBoundingSphere();
    ptsObj.visible = true;
    shipPicksRef.current = picks;
  }, [ships, showShips, mountKey]);

  // Webcam layer effect: the ship cloud's sibling — one Points draw
  // call, single atlas cell, no rotation, one warm amber tint for
  // every camera. Webcams ride at r=1.026, between ships and
  // flights: they stand ON the land the overlays draw.
  useEffect(() => {
    const ptsObj = webcamPointsRef.current;
    if (!ptsObj) return;
    webcamPicksRef.current = [];
    if (!showWebcams || webcams.length === 0) {
      ptsObj.visible = false;
      ptsObj.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([], 3),
      );
      return;
    }
    const arr = new Float32Array(webcams.length * 3);
    const kindArr = new Float32Array(webcams.length);
    const headArr = new Float32Array(webcams.length);
    const colorArr = new Float32Array(webcams.length * 3);
    const sizeArr = new Float32Array(webcams.length);
    const picks: Array<{ w: GlobeWebcam; dir: THREE.Vector3 }> = [];
    webcams.forEach((w, i) => {
      const v = latLngToVec3(w.lat, w.lng, 1.026);
      arr[i * 3] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
      kindArr[i] = 0;
      headArr[i] = 0;
      colorArr[i * 3] = 1.0;
      colorArr[i * 3 + 1] = 0.78;
      colorArr[i * 3 + 2] = 0.38;
      sizeArr[i] = 15;
      picks.push({ w, dir: v.clone().normalize() });
    });
    ptsObj.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(arr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aKind",
      new THREE.BufferAttribute(kindArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aHeading",
      new THREE.BufferAttribute(headArr, 1),
    );
    ptsObj.geometry.setAttribute(
      "aColor",
      new THREE.BufferAttribute(colorArr, 3),
    );
    ptsObj.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(sizeArr, 1),
    );
    ptsObj.geometry.computeBoundingSphere();
    ptsObj.visible = true;
    webcamPicksRef.current = picks;
  }, [webcams, showWebcams, mountKey]);

  // RainViewer overlays: a composed frame canvas becomes the overlay
  // mesh's texture; no frame → the mesh hides (the layer degrades
  // silently, per the v2.0口径).
  useEffect(() => {
    const mesh = radarMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (radarFrame?.canvas) {
      const tex = new THREE.CanvasTexture(radarFrame.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const old = mat.map;
      mat.map = tex;
      mat.needsUpdate = true;
      if (old) old.dispose();
      mesh.visible = true;
    } else {
      mesh.visible = false;
    }
  }, [radarFrame, mountKey]);

  useEffect(() => {
    const mesh = cloudMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (!cloudOn) {
      mesh.visible = false;
      return;
    }
    if (cloudFrame?.canvas) {
      const tex = new THREE.CanvasTexture(cloudFrame.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Anisotropic filtering like the basemap's: without it the
      // cloud field smears and blocks up toward the limb, where the
      // shell is most foreshortened. Opacity eased 0.6 → 0.55 so
      // the (now sharper) basemap keeps its land detail under the
      // cloud field instead of being washed by it.
      tex.anisotropy = 8;
      const old = mat.map;
      mat.map = tex;
      mat.opacity = 0.55;
      mat.needsUpdate = true;
      if (old) old.dispose();
      mesh.visible = true;
    } else {
      // No REAL satellite frame right now (v3.0: the synthetic cloud
      // texture fallback is retired — the cloud layer shows the
      // Himawari AHI frame composited over RainViewer's global
      // infrared mosaic, both real imagery; when neither is
      // available the layer hides rather than painting fake clouds).
      mesh.visible = false;
    }
  }, [cloudFrame, cloudOn, mountKey]);

  // Selection highlight: the tapped place's administrative unit,
  // filled + outlined from its real boundary rings (Google-Maps
  // style), shown while its weather card is open and cleared with it.
  // Resolution is async (the grouped ADM1 asset lazy-loads on first
  // use) and token-guarded against rapid re-selections. A point that
  // resolves to no unit (open ocean) gets only the small fallback dot.
  const highlightTokenRef = useRef(0);
  useEffect(() => {
    const token = ++highlightTokenRef.current;
    const dot = selDotRef.current;
    const clearHighlight = () => {
      const g = highlightGroupRef.current;
      if (g) {
        groupRef.current?.remove(g);
        g.traverse((obj) => {
          const anyObj = obj as unknown as {
            geometry?: THREE.BufferGeometry;
            material?: THREE.Material;
          };
          anyObj.geometry?.dispose();
          anyObj.material?.dispose();
        });
        highlightGroupRef.current = null;
      }
    };
    const rec = cityRecsRef.current.find((r) => r.city.id === activeId);
    // Region-picker places (a Chinese prefecture not in the library, a
    // US county, a state capital) have no city record: resolve them
    // from the focus coordinates the flight was given. The focus PROP
    // is the primary source — it is current in this same commit,
    // while lastFocusRef is only updated by the flight effect that
    // runs after this one (reading it first left every non-library
    // selection unhighlighted).
    const foc =
      !rec && focus && focus.id === activeId
        ? focus
        : !rec &&
            lastFocusRef.current &&
            lastFocusRef.current.id === activeId
          ? lastFocusRef.current
          : null;
    if (!rec && !foc) {
      clearHighlight();
      if (dot) dot.visible = false;
      return;
    }
    const lat = rec ? rec.city.lat : foc!.lat;
    const lng = rec ? rec.city.lng : foc!.lng;
    if (dot) {
      dot.position.copy(latLngToVec3(lat, lng, 1.016));
      dot.visible = false; // until resolution says "no unit"
    }
    void resolveHighlightRings(lat, lng).then((rings) => {
      if (token !== highlightTokenRef.current) return;
      clearHighlight();
      const grp = groupRef.current;
      if (!grp) return;
      const display = rings && rings.length > 0 ? buildHighlightDisplay(rings) : null;
      if (display) {
        grp.add(display);
        highlightGroupRef.current = display;
        if (dot) dot.visible = false;
      } else if (dot) {
        dot.visible = true;
      }
    });
  }, [activeId, mountKey, focus]);

  // Fly to the focused city; depth follows the city's LABEL tier (a
  // demoted tier-1 city like Tianjin must descend into the L2 band or
  // its name plate would stay gated off at the resting distance). The
  // flight ends still — no automatic orbit drift (the user asked for a
  // globe that doesn't move on its own).
  //
  // Two no-pop guards, both aimed at "zoomed all the way in and it
  // bounced back out":
  // (1) Each focus request is applied once (exact-match guard in
  //     the effect). mountKey is deliberately NOT a dependency:
  //     after a scene rebuild the camera state is restored from the
  //     live goal refs / saved camera, and re-applying the focus
  //     here would slam the distance back to the place's resting
  //     depth, erasing the user's pinch zoom.
  // (2) A target already on screen (a tap, by definition) never
  //     zooms OUT past the current depth — it only recentres. A
  //     deep-zoom tap used to fly back to the resting distance.
  const appliedFocusRef = useRef<{
    nonce: number;
    id: string;
    lat: number;
    lng: number;
    dist?: number;
  } | null>(null);
  useEffect(() => {
    if (!focus) return;
    // Skip only an exact re-application of the SAME request (same
    // nonce AND same place): nonces are Date.now(), and two genuine
    // selections in the same millisecond (a picker drill step and
    // its leaf, rapid taps) share a nonce — keying on the nonce
    // alone swallowed the second flight and stranded the camera at
    // the drill step's distance.
    const a = appliedFocusRef.current;
    if (
      a &&
      a.nonce === focus.nonce &&
      a.id === focus.id &&
      a.lat === focus.lat &&
      a.lng === focus.lng &&
      a.dist === focus.dist
    ) {
      return;
    }
    appliedFocusRef.current = {
      nonce: focus.nonce,
      id: focus.id,
      lat: focus.lat,
      lng: focus.lng,
      dist: focus.dist,
    };
    lastFocusRef.current = focus;
    let target: number;
    if (typeof focus.dist === "number") {
      target = THREE.MathUtils.clamp(focus.dist, MIN_DIST, MAX_DIST);
    } else {
      const labelTier = CITIES.find((c) => c.id === focus.id)?.labelTier ?? focus.tier;
      target = labelTier === 1 ? 2.52 : labelTier === 2 ? 2.02 : 1.5;
    }
    // View-centre direction under the CURRENT goal orientation,
    // measured before the new orientation replaces it.
    const prevCentre = new THREE.Vector3(0, 0, 1).applyQuaternion(
      goalQuatRef.current.clone().invert(),
    );
    const targetDir = latLngToVec3(focus.lat, focus.lng, 1).normalize();
    const angDeg = (prevCentre.angleTo(targetDir) * 180) / Math.PI;
    // Orbit model (edit #27): a flight sets the goal CENTRE (with
    // the same aesthetic latitude clamp flights have always used:
    // −58…66) and the goal orientation derives from it — a flight
    // can no more land rolled than a drag can.
    goalOrbitRef.current = {
      lat: Math.max(-58, Math.min(66, focus.lat)),
      lng: focus.lng,
    };
    syncGoalFromOrbit();
    goalDistRef.current =
      angDeg < 28 ? Math.min(target, goalDistRef.current) : target;
    lastFocusAtRef.current = performance.now();
  }, [focus]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#04070b] px-6 text-center">
        <p className="text-sm text-[var(--dim)]">
          3D 地球仪无法在此设备上启动（WebGL 不可用）。
        </p>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <div
        ref={mountRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        aria-label="3D 地球仪：拖动旋转（放大后拖动自动变慢），滚轮或捏合放大逐级显示更多城市与行政区边界，点城市名牌、地区名牌、地级市名牌或球面任意位置查看当地实时天气"
        role="img"
      />
      {ctxLost && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#04070b]/88 px-6">
          <div className="max-w-xs text-center">
            <p className="text-sm text-[var(--text)]">
              图形被系统临时回收，正在自动恢复…
            </p>
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              全屏切换时偶尔会发生，通常一两秒内自愈；若一直不恢复，点下面重建地球仪。
            </p>
            <button
              type="button"
              aria-label="重建地球仪"
              onClick={() => {
                setCtxLost(false);
                setMountKey((k) => k + 1);
              }}
              className="font-console mt-3 min-h-10 border border-[var(--accent)] px-4 py-2 text-xs text-[var(--accent)] transition-opacity duration-200 hover:opacity-85"
            >
              重建地球仪
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
