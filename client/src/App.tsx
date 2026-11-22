import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import {
Globe,
type GlobeEvent,
type GlobeFlight,
type GlobeFocus,
type GlobeOverlayFrame,
type GlobeQuake,
type GlobeShip,
type GlobeStation,
type GlobeWebcam,
} from "./Globe";
import earthDaySmUrl from "./assets/earth-day-sm.jpg";
import { CITIES, CITY_BY_ID, type City } from "./cities";
import type { SubPlace } from "./RegionPicker";
import { findTwilightCities, twilightInfo } from "./solar";
import {
composeRainFrame,
featherCanvas,
type RainStyle,
} from "./rainviewer";
import { composeGeoCloudFrame } from "./himawari";
import { auroraProbAt, buildAuroraCanvas } from "./aurora";

// A selected place is either a library city or a region-picker place
// (Chinese prefecture, US county, state capital) — the card treats them
// identically; only the favorite star is library-only.
interface PlaceSel extends SubPlace {
  capital: boolean;
}

type Weather = ApiResponse<typeof api, "getCityWeather">;
type StreetView = ApiResponse<typeof api, "getStreetView">;


// Layer toggles: 天气 (city plates) / 地震 / 事件 / 云层 / 雷达 plus
// v3.0's 极光 / 空间站 / 实时航班， the AIS 实时船舶 layer and the
// Windy 全球摄像头 layer — the v3.0+ layers are all default OFF and
// fetch only while switched on (lazy by design).
interface LayerState {
  weather: boolean;
  quakes: boolean;
  events: boolean;
  clouds: boolean;
  radar: boolean;
  aurora: boolean;
  stations: boolean;
  flights: boolean;
  ships: boolean;
  webcams: boolean;
}

const EVENT_CAT_ZH: Record<string, string> = {
  wildfires: "野火",
  volcanoes: "火山",
  severeStorms: "严重风暴",
  floods: "洪水",
};
// Category accent colours (globe marker rings, panel dots, chips) —
// one colour language for natural events everywhere in the UI.
const EVENT_CAT_COLOR: Record<string, string> = {
  wildfires: "#ff8a3a",
  volcanoes: "#ff5f56",
  severeStorms: "#4cc3ff",
  floods: "#38b6ff",
};

// WMO weather-code → Chinese description + glyph + atmosphere tone (the
// tone drives the card's fallback backdrop when no photo exists).
const CODE_MAP: Record<
  number,
  { label: string; icon: string; tone: "clear" | "cloudy" | "rain" | "snow" | "night" }
> = {
  0: { label: "晴", icon: "☀", tone: "clear" },
  1: { label: "晴间多云", icon: "🌤", tone: "clear" },
  2: { label: "多云", icon: "⛅", tone: "cloudy" },
  3: { label: "阴", icon: "☁", tone: "cloudy" },
  45: { label: "雾", icon: "🌫", tone: "cloudy" },
  48: { label: "雾凇", icon: "🌫", tone: "cloudy" },
  51: { label: "毛毛雨", icon: "🌦", tone: "rain" },
  53: { label: "毛毛雨", icon: "🌦", tone: "rain" },
  55: { label: "毛毛雨", icon: "🌦", tone: "rain" },
  56: { label: "冻毛毛雨", icon: "🌦", tone: "rain" },
  57: { label: "冻毛毛雨", icon: "🌦", tone: "rain" },
  61: { label: "小雨", icon: "🌧", tone: "rain" },
  63: { label: "中雨", icon: "🌧", tone: "rain" },
  65: { label: "大雨", icon: "🌧", tone: "rain" },
  66: { label: "冻雨", icon: "🌧", tone: "rain" },
  67: { label: "冻雨", icon: "🌧", tone: "rain" },
  71: { label: "小雪", icon: "🌨", tone: "snow" },
  73: { label: "中雪", icon: "🌨", tone: "snow" },
  75: { label: "大雪", icon: "❄", tone: "snow" },
  77: { label: "雪粒", icon: "🌨", tone: "snow" },
  80: { label: "阵雨", icon: "🌦", tone: "rain" },
  81: { label: "阵雨", icon: "🌦", tone: "rain" },
  82: { label: "暴雨阵雨", icon: "🌧", tone: "rain" },
  85: { label: "阵雪", icon: "🌨", tone: "snow" },
  86: { label: "阵雪", icon: "🌨", tone: "snow" },
  95: { label: "雷暴", icon: "⛈", tone: "rain" },
  96: { label: "雷暴伴冰雹", icon: "⛈", tone: "rain" },
  99: { label: "雷暴伴冰雹", icon: "⛈", tone: "rain" },
};

function codeInfo(code: number | null, isDay: boolean | null) {
  const base =
    (code != null ? CODE_MAP[code] : undefined) ??
    ({ label: "—", icon: "·", tone: "cloudy" } as const);
  if (code === 0 && isDay === false) {
    return { label: "晴夜", icon: "🌙", tone: "night" as const };
  }
  if ((code === 1 || code === 2) && isDay === false) {
    return { ...base, tone: "night" as const, icon: "🌙" };
  }
  return base;
}

// China-standard PM2.5 bands: 优 / 良 / 轻度污染 / 中度及以上.
function pmLevel(pm25: number): { text: string; color: string } {
  if (pm25 <= 35) return { text: "优", color: "#3fb950" };
  if (pm25 <= 75) return { text: "良", color: "#e3c341" };
  if (pm25 <= 115) return { text: "轻度污染", color: "#ffa657" };
  return { text: "中度及以上污染", color: "#ff5f56" };
}

const TONE_BG: Record<string, string> = {
  clear: "linear-gradient(135deg,#7a4d12 0%,#b97e1e 45%,#2b4a73 100%)",
  cloudy: "linear-gradient(135deg,#33475e 0%,#4d6a8a 55%,#22344a 100%)",
  rain: "linear-gradient(135deg,#16324a 0%,#1f4e63 55%,#0d2233 100%)",
  snow: "linear-gradient(135deg,#5b7186 0%,#93a9bd 55%,#42566b 100%)",
  night: "linear-gradient(135deg,#060a1c 0%,#101c3f 55%,#0a1226 100%)",
};

function fmtClock(tz: string, now: number, withSec: boolean): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      ...(withSec ? { second: "2-digit" as const } : {}),
      hour12: false,
      timeZone: tz,
    }).format(new Date(now));
  } catch {
    return "--:--";
  }
}

function fmtNum(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

// Precipitation display style (edit 2026-11-17): "soft" feathers the
// radar echoes into soft weather systems (the user's 「降水丑」 fix);
// "crisp" keeps the classic hard-edged radar blocks. Soft is the
// default; the choice is remembered across opens.
const RADAR_STYLE_KEY = "earth-online-radar-style";
function loadRadarStyle(): RainStyle {
  try {
    return localStorage.getItem(RADAR_STYLE_KEY) === "crisp"
      ? "crisp"
      : "soft";
  } catch {
    return "soft";
  }
}
// Set once native fullscreen has provably misbehaved on this device
// (entered but rendered broken, or had to be force-exited): later taps
// then go straight to the dependable immersive mode instead of flashing
// the broken native path again.
const FS_BROKEN_KEY = "earth-online-weather-fs-broken";
// Set while immersive (pseudo) fullscreen is on. Immersive mode is
// pure page state, so if the host webview restarts the page mid-
// fullscreen (Android webviews do this under memory pressure — the
// page quietly reloads and the user sees fullscreen "exit by
// itself"), the reload finds this flag and re-enters immersive mode
// instead of landing back in the framed layout. sessionStorage is
// per-tab-session: a genuinely fresh open never restores.
const FS_RESTORE_KEY = "earth-online-weather-fs-restore";

function loadNativeBroken(): boolean {
  try {
    return localStorage.getItem(FS_BROKEN_KEY) === "1";
  } catch {
    return false;
  }
}

// True only when this page load is a RELOAD (webview restart / page
// refresh) and immersive fullscreen was on when the previous instance
// died. A normal first navigation never restores.
function loadFsRestore(): boolean {
  try {
    if (sessionStorage.getItem(FS_RESTORE_KEY) !== "1") return false;
    const entries = performance.getEntriesByType?.("navigation");
    const nav = entries?.[0] as PerformanceNavigationTiming | undefined;
    // No navigation timing available → trust the flag.
    return !nav || nav.type === "reload";
  } catch {
    return false;
  }
}

// True on touch-primary devices (phones/tablets). Their in-app
// webviews are exactly where native fullscreen white-screens: the
// entry DOES engage, then the host swaps the canvas surface and the
// WebGL layer presents white — while every size/buffer probe still
// reads healthy, so no health check can catch it, and the forced exit
// a probe triggers mid-transition can wedge the surface for good.
// On these devices we never request native fullscreen at all: the tap
// goes straight to immersive mode, no surface swap ever happens, and
// the globe that was already on screen simply keeps painting.
function isCoarsePointer(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}


// Loading skeleton for the weather cards: the card (and its photo
// header) paints immediately on tap; only the numbers wait for the
// network, as soft pulsing blocks in the same layout as the real data.
function WeatherSkeleton({ cityZh, compact }: { cityZh: string; compact?: boolean }) {
  return (
    <div role="status" aria-label={`正在加载${cityZh}的实时天气`} className={compact ? "py-2" : "py-2"}>
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-white/10" />
        <div className="min-w-0 flex-1">
          <div className="h-9 w-24 animate-pulse bg-white/10" />
          <div className="mt-2 h-3.5 w-32 animate-pulse bg-white/[0.07]" />
        </div>
      </div>
      {!compact && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border border-white/10 bg-white/[0.04] px-2 py-2">
              <div className="mx-auto h-2.5 w-8 animate-pulse bg-white/10" />
              <div className="mx-auto mt-1.5 h-4 w-12 animate-pulse bg-white/[0.07]" />
            </div>
          ))}
        </div>
      )}
      <p className="font-console mt-3 text-center text-[11px] text-[var(--dim)]">
        正在拉取 {cityZh} 的实时天气…
      </p>
    </div>
  );
}

// Street-level photo block (Mapillary) inside the weather cards.
// Loads independently of the weather data and degrades to a single
// quiet line — 附近暂无街景实拍 — on no coverage, upstream failure or
// a broken image; it never blocks or breaks the card itself. The
// attribution line is a CC BY-SA licence requirement, not decoration.
// The title row carries a manual 重新加载 button (the user's ask):
// it re-runs ONLY the street-view query for the same coordinates —
// a fresh lookup may return a different photo or recover from a
// failed/empty result — and is disabled while a lookup is in flight.
function StreetViewBlock({
  street,
  placeZh,
  onReload,
}: {
  street: {
    data: StreetView | undefined;
    isPending: boolean;
    isError: boolean;
    isFetching: boolean;
  };
  placeZh: string;
  onReload: () => void;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const d = street.data;
  const imageUrl = d && d.found ? d.imageUrl : null;
  // A reload can return a different photo: give the new image a
  // fresh chance instead of keeping a previous broken-image verdict.
  useEffect(() => {
    setImgBroken(false);
  }, [imageUrl]);

  const header = (
    <div className="flex items-center gap-2">
      <span className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
        街景实拍
      </span>
      <button
        type="button"
        aria-label="重新加载街景实拍"
        disabled={street.isFetching}
        onClick={onReload}
        className="font-console ml-auto inline-flex min-h-9 items-center border border-white/25 bg-black/30 px-2.5 py-1 text-[11px] text-[var(--text)] transition-colors duration-200 disabled:opacity-40"
      >
        ⟳ 重新加载
      </button>
    </div>
  );

  if (street.isPending) {
    return (
      <div className="mt-2 border border-white/15 bg-black/35 px-2.5 py-2">
        {header}
        <p className="font-console mt-1.5 text-[11px] text-[var(--dim)]">
          正在查找附近街景…
        </p>
      </div>
    );
  }
  if (street.isError || !d || !d.found || !d.imageUrl || imgBroken) {
    return (
      <div className="mt-2 border border-white/15 bg-black/35 px-2.5 py-2">
        {header}
        <p className="font-console mt-1.5 text-[11px] text-[var(--dim)]">
          附近暂无街景实拍
        </p>
      </div>
    );
  }
  const year = d.capturedAt ? new Date(d.capturedAt).getFullYear() : NaN;
  const pageUrl = d.imageId
    ? `https://www.mapillary.com/app/?pKey=${d.imageId}`
    : null;
  const img = (
    <>
      <img
        src={d.imageUrl}
        alt={`${placeZh}附近的街景实拍`}
        className="h-40 w-full object-cover sm:h-44"
        loading="lazy"
        decoding="async"
        onError={() => setImgBroken(true)}
      />
      {d.isPano && (
        <span className="font-console absolute top-2 left-2 bg-black/60 px-1.5 py-0.5 text-[10px] font-bold tracking-[0.1em] text-white">
          全景
        </span>
      )}
    </>
  );
  return (
    <div className="mt-2 border border-white/15 bg-black/35 p-2">
      {header}
      <div className="mt-2">
        {pageUrl ? (
          <a
            href={pageUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="在 Mapillary 打开这张街景照片"
            className="relative block overflow-hidden"
          >
            {img}
          </a>
        ) : (
          <div className="relative overflow-hidden">{img}</div>
        )}
      </div>
      <p className="font-console mt-2 px-0.5 text-[11px] leading-relaxed text-[var(--dim)]">
        距此地约 {d.distanceM != null ? `${d.distanceM} 米` : "—"}
        {Number.isFinite(year) ? ` · 拍摄于 ${year} 年` : ""} · © Mapillary
        贡献者 · CC BY-SA
      </p>
    </div>
  );
}

// ── More menu (edit #29's layer panel, re-homed by the homepage
// cleanup): the homepage used to carry a whole strip of buttons
// （随机 / 漫游 / 自转 / 全屏 / 横屏全屏 / 地区选择 / 图层 / 地球此刻 /
// 搜索 / 收藏）. The user cut that down to the bone — the stage now
// keeps ONE entry, this 「图层」面板, and everything that survived
// lives inside its panel: basemap choices with REAL texture
// previews, data layers as switch rows carrying a miniature of the
// marker they draw on the globe plus a live count/source line,
// radar playback + intensity legend inside the radar row, the 追霞
// controls, the 时光机 switch, and a 显示 section （全屏 / 横屏全屏 /
// 自转 / 地球此刻）. Used in the header and in the fullscreen
// control stack. On phones the panel becomes a bottom sheet; on
// sm+ it drops down from the button. All state stays in App —
// this is presentation.
interface LayerMenuProps {
  // Open state is CONTROLLED by App (not local): the bottom floating
  // capsule must step aside while the panel is open — the panel is a
  // bottom sheet on phones and its lowest rows （时光机 section) were
  // painted over by the capsule showing through the translucent
  // panel face (2026-11-18 recording). App hides the capsule on
  // this signal, the same way it already does for detail cards.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layers: LayerState;
  onToggleLayer: (k: keyof LayerState) => void;
  quakeCount: number | null;
  eventCount: number | null;
  auroraNote: string | null;
  flightCount: number | null;
  flightSource: string | null;
  shipCount: number | null;
  shipSource: string | null;
  webcamCount: number | null;
  stationSource: string | null;
  // Display section (homepage-cleanup edit): the slimmed homepage
  // keeps ONE stage entry — this menu — so the fullscreen / spin /
  // 地球此刻 controls that used to be their own header buttons live
  // here as rows. In fullscreen the 全屏 row reads 退出全屏 and the
  // 横屏 row hides (already in a fullscreen presentation).
  fsMode: boolean;
  onFullscreen: () => void;
  onLandscapeFs: () => void;
  spinOn: boolean;
  onToggleSpin: () => void;
  todayOpen: boolean;
  onToggleToday: () => void;
  timeOn: boolean;
  onToggleTime: () => void;
  timeLabel: string;
  radarFrameCount: number;
  radarIdx: number;
  radarPlaying: boolean;
  onToggleRadarPlay: () => void;
  radarFrameTime: string | null;
  radarStyle: RainStyle;
  onRadarStyle: (s: RainStyle) => void;
  twilightOn: boolean;
  onToggleTwilight: () => void;
  chaseOn: boolean;
  onToggleChase: () => void;
  onGoSunset: () => void;
  twilightCount: number;
}

// Sunset glyph as a true vector (inline SVG, stroke = currentColor):
// a half sun sinking to a horizon line with a down chevron. Replaces
// the 🌇 emoji, whose raster rendering varied by platform and could
// not scale cleanly (edit #31 — the user's 「图标不是矢量的」).
function SunsetIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      <path d="M12 9V3" />
      <path d="m8.5 5.5-1.8-1.8" />
      <path d="m15.5 5.5 1.8-1.8" />
      <path d="M5.6 15a6.5 6.5 0 0 1 12.8 0" />
      <path d="M3 19h18" />
      <path d="M5 22h14" />
      <path d="m9.5 11.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

// Flight-class glyphs for the detail card — the same top-down
// silhouettes the globe draws (paper plane / business jet /
// propeller plane / helicopter), as inline SVG so card and globe
// always agree.
const FLIGHT_KIND_ZH: Record<GlobeFlight["kind"], string> = {
  airliner: "民航客机",
  bizjet: "商务机",
  prop: "螺旋桨飞机",
  heli: "直升机",
};

function FlightKindIcon({
  kind,
  className = "h-5 w-5",
}: {
  kind: GlobeFlight["kind"];
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 128 128"
      fill="currentColor"
      className={`shrink-0 ${className}`}
    >
      {kind === "airliner" && (
        <>
          <path d="M64 6 114 118 64 94 14 118Z" />
          <path d="M64 6 64 94 46 118 58 66Z" fill="#0a141f" opacity="0.55" />
        </>
      )}
      {kind === "bizjet" && (
        <>
          {/* Sleek swept-wing jet: aft swept wings, twin rear
              engines, T-tail — same glyph as the globe atlas. */}
          <path d="M64 4Q71 26 70.5 52L69 104Q68.5 113 64 113Q59.5 113 59 104L57.5 52Q57 26 64 4Z" />
          <path d="M60 50 13 92l4 9 43-27Z" />
          <path d="M68 50l47 42-4 9-43-27Z" />
          <ellipse cx="52" cy="84" rx="4.5" ry="9.5" />
          <ellipse cx="76" cy="84" rx="4.5" ry="9.5" />
          <rect x="41" y="105" width="46" height="8" rx="2" />
        </>
      )}
      {kind === "prop" && (
        <>
          {/* Straight-wing prop plane; the wide flat ellipse at
              the nose is the propeller disc, hub dotted. */}
          <path d="M64 10c8 22 9 40 8 52l-1 46H57l-1-46c-1-22 0-30 8-52Z" />
          <rect x="8" y="54" width="112" height="12" rx="4" />
          <rect x="39" y="100" width="50" height="10" rx="4" />
          <ellipse cx="64" cy="11" rx="27" ry="6.5" fillOpacity="0.85" />
          <circle cx="64" cy="11" r="4.5" />
        </>
      )}
      {kind === "heli" && (
        <>
          {/* Rotor disc + teardrop cabin + tail — the same glyph
              the globe's atlas draws (edit #37 redraw: the old
              rotor-bar cross read as a plus sign, not a 🚁). */}
          <circle cx="64" cy="44" r="42" fillOpacity="0.16" />
          <circle
            cx="64"
            cy="44"
            r="42"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeOpacity="0.55"
          />
          <path d="M58.5 56h11l-3 54h-5Z" />
          <rect x="46" y="100" width="36" height="7" rx="3" />
          <rect x="61.5" y="106" width="5" height="12" rx="2" />
          <path
            fillRule="evenodd"
            d="M64 15c14 0 20.5 14 20.5 30 0 16-8 26-20.5 26S43.5 61 43.5 45C43.5 29 50 15 64 15Zm-9 18c0-7 4-13 9-13s9 6 9 13-4 13-9 13-9-6-9-13Z"
          />
        </>
      )}
    </svg>
  );
}

// Ship-class glyphs for the detail card + layer panel — the same
// top-down hull silhouettes the globe's ship atlas draws (cargo /
// tanker / passenger / fishing / other), as inline SVG.
const SHIP_KIND_ZH: Record<GlobeShip["kind"], string> = {
  cargo: "货船",
  tanker: "油轮",
  passenger: "客船",
  fishing: "渔船",
  other: "船舶",
};

const SHIP_KIND_COLOR: Record<GlobeShip["kind"], string> = {
  cargo: "#9edcff",
  tanker: "#73f2cc",
  passenger: "#ebf7ff",
  fishing: "#aef29e",
  other: "#b8cce6",
};

function ShipKindIcon({
  kind,
  className = "h-5 w-5",
}: {
  kind: GlobeShip["kind"];
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 128 128"
      fill="currentColor"
      className={`shrink-0 ${className}`}
    >
      {kind === "cargo" && (
        <>
          <path d="M64 6Q79 22 79 46v56q0 14-8 14H57q-8 0-8-14V46Q49 22 64 6Z" />
          <rect x="49.5" y="62" width="29" height="2.6" fill="#0a141f" opacity="0.5" />
          <rect x="49.5" y="84" width="29" height="2.6" fill="#0a141f" opacity="0.5" />
          <rect x="62.7" y="34" width="2.6" height="62" fill="#0a141f" opacity="0.5" />
          <rect x="54" y="100" width="20" height="9" />
        </>
      )}
      {kind === "tanker" && (
        <>
          <path d="M64 6Q79 22 79 46v56q0 14-8 14H57q-8 0-8-14V46Q49 22 64 6Z" />
          <circle cx="64" cy="34" r="10.5" />
          <circle cx="64" cy="56" r="10.5" />
          <circle cx="64" cy="78" r="10.5" />
          <circle cx="64" cy="98" r="10.5" />
          <rect x="61.8" y="16" width="4.4" height="100" fill="#0a141f" opacity="0.5" />
          <rect x="57" y="14" width="14" height="7" />
        </>
      )}
      {kind === "passenger" && (
        <>
          <path d="M64 6Q81 22 81 46v56q0 14-8 14H55q-8 0-8-14V46Q47 22 64 6Z" />
          <rect x="55" y="30" width="18" height="62" />
          <rect x="45" y="24" width="38" height="8" />
          <circle cx="64" cy="104" r="6" />
        </>
      )}
      {kind === "fishing" && (
        <>
          <path d="M64 24Q75 36 75 58l-2 40q-1 9-9 9t-9-9l-2-40Q53 36 64 24Z" />
          <path
            d="M64 54 52 96M64 54l12 42"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.4"
          />
          <circle cx="64" cy="52" r="4.6" />
        </>
      )}
      {kind === "other" && (
        <>
          <path d="M64 6Q77 22 77 46v56q0 14-8 14H59q-8 0-8-14V46Q51 22 64 6Z" />
          <rect x="55" y="92" width="18" height="14" />
        </>
      )}
    </svg>
  );
}

// AIS navigational status codes → Chinese (the card's 状态 cell).
const NAV_STAT_ZH: Record<number, string> = {
  0: "航行中",
  1: "锚泊",
  2: "失控",
  3: "操纵受限",
  4: "吃水受限",
  5: "靠泊",
  6: "搁浅",
  7: "捕鱼作业",
  8: "靠帆航行",
};

function navStatText(v: number | null): string {
  if (v == null) return "—";
  return NAV_STAT_ZH[v] ?? "—";
}

// 国籍 for the flight card: civil-aviation registration prefixes are
// allocated by country, so the registration's prefix names the country
// of registry (B- 中国大陆, N 美国, JA 日本, D- 德国 …). Rules run in
// order, most specific first; a registration with no match (military
// serials, unallocated prefixes) — or no registration at all — reads
// 未知 rather than guessing.
const REG_COUNTRY_RULES: Array<[RegExp, string]> = [
  [/^B-?\d/, "中国"],
  [/^JA\d/, "日本"],
  [/^HL\d/, "韩国"],
  [/^N\d/, "美国"],
  [/^C-[FG]/, "加拿大"],
  [/^VH-/, "澳大利亚"],
  [/^VT-/, "印度"],
  [/^RA-/, "俄罗斯"],
  [/^D-/, "德国"],
  [/^G-/, "英国"],
  [/^F-/, "法国"],
  [/^I-/, "意大利"],
  [/^EC-/, "西班牙"],
  [/^CS-/, "葡萄牙"],
  [/^PH-/, "荷兰"],
  [/^HB-/, "瑞士"],
  [/^OE-/, "奥地利"],
  [/^SE-/, "瑞典"],
  [/^LN-/, "挪威"],
  [/^OY-/, "丹麦"],
  [/^OH-/, "芬兰"],
  [/^EI-/, "爱尔兰"],
  [/^SP-/, "波兰"],
  [/^OK-/, "捷克"],
  [/^HA-/, "匈牙利"],
  [/^SX-/, "希腊"],
  [/^TC-/, "土耳其"],
  [/^4X-/, "以色列"],
  [/^A6-/, "阿联酋"],
  [/^A7-/, "卡塔尔"],
  [/^HZ-/, "沙特阿拉伯"],
  [/^A9C-/, "巴林"],
  [/^A4O-/, "阿曼"],
  [/^9K-/, "科威特"],
  [/^JY-/, "约旦"],
  [/^SU-/, "埃及"],
  [/^ZS-/, "南非"],
  [/^ET-/, "埃塞俄比亚"],
  [/^5Y-/, "肯尼亚"],
  [/^9M-/, "马来西亚"],
  [/^9V-/, "新加坡"],
  [/^HS-/, "泰国"],
  [/^VN-/, "越南"],
  [/^PK-/, "印度尼西亚"],
  [/^RP-C/, "菲律宾"],
  [/^ZK-/, "新西兰"],
  [/^9A-/, "克罗地亚"],
  [/^OO-/, "比利时"],
  [/^YR-/, "罗马尼亚"],
  [/^LZ-/, "保加利亚"],
  [/^UR-/, "乌克兰"],
  [/^LY-/, "立陶宛"],
  [/^YL-/, "拉脱维亚"],
  [/^ES-/, "爱沙尼亚"],
  [/^9H-/, "马耳他"],
  [/^5B-/, "塞浦路斯"],
  [/^CC-/, "智利"],
  [/^LV-/, "阿根廷"],
  [/^LQ-/, "阿根廷"],
  [/^PR-/, "巴西"],
  [/^PP-/, "巴西"],
  [/^PT-/, "巴西"],
  [/^PU-/, "巴西"],
  [/^XA-/, "墨西哥"],
  [/^XB-/, "墨西哥"],
  [/^XC-/, "墨西哥"],
  [/^HK-/, "哥伦比亚"],
  [/^OB-/, "秘鲁"],
  [/^4K-/, "阿塞拜疆"],
  [/^UP-/, "哈萨克斯坦"],
  [/^JU-/, "蒙古"],
];

function regCountry(reg: string | null): string {
  if (!reg) return "未知";
  const r = reg.trim().toUpperCase();
  if (!r) return "未知";
  for (const [re, country] of REG_COUNTRY_RULES) {
    if (re.test(r)) return country;
  }
  return "未知";
}

// Registry country for the card, best source first (edit #37 —
// the row now comes from the aircraft archive where possible):
// the registration-prefix rules above (Chinese names) win; when
// they miss, adsbdb's own registry country for the airframe takes
// over — its ISO code through this small map, else its English
// country name verbatim. Nothing matched anywhere → 未知.
const ISO_COUNTRY_ZH: Record<string, string> = {
  CN: "中国", HK: "中国香港", TW: "中国台湾", MO: "中国澳门",
  US: "美国", JP: "日本", KR: "韩国", DE: "德国", GB: "英国",
  FR: "法国", IT: "意大利", ES: "西班牙", NL: "荷兰", CH: "瑞士",
  AT: "奥地利", BE: "比利时", SE: "瑞典", NO: "挪威", DK: "丹麦",
  FI: "芬兰", PL: "波兰", CZ: "捷克", IE: "爱尔兰", PT: "葡萄牙",
  GR: "希腊", TR: "土耳其", RU: "俄罗斯", UA: "乌克兰",
  AE: "阿联酋", QA: "卡塔尔", SA: "沙特阿拉伯", IL: "以色列",
  IN: "印度", TH: "泰国", SG: "新加坡", MY: "马来西亚",
  ID: "印度尼西亚", VN: "越南", PH: "菲律宾", AU: "澳大利亚",
  NZ: "新西兰", CA: "加拿大", MX: "墨西哥", BR: "巴西",
  AR: "阿根廷", CL: "智利", CO: "哥伦比亚", PE: "秘鲁",
  ZA: "南非", EG: "埃及", KE: "肯尼亚", ET: "埃塞俄比亚",
  KZ: "哈萨克斯坦", UZ: "乌兹别克斯坦", AZ: "阿塞拜疆",
  MN: "蒙古", PK: "巴基斯坦", BD: "孟加拉国", LK: "斯里兰卡",
  MM: "缅甸", KH: "柬埔寨", LA: "老挝", NP: "尼泊尔",
};

function flightCountry(
  reg: string | null,
  archive: { country: string | null; countryIso: string | null } | null,
): string {
  const byPrefix = regCountry(reg);
  if (byPrefix !== "未知") return byPrefix;
  if (archive?.countryIso) {
    const zh = ISO_COUNTRY_ZH[archive.countryIso.toUpperCase()];
    if (zh) return zh;
  }
  return archive?.country ?? "未知";
}

// 爬升率 cell: the feed's live vertical rate (m/s). |v| < 0.25 reads
// as level flight （平飞） — readsb rates jitter around zero in cruise.
function vrateText(v: number | null): string {
  if (v == null) return "—";
  if (Math.abs(v) < 0.25) return "平飞";
  return v > 0 ? `↑ ${v.toFixed(1)} m/s` : `↓ ${Math.abs(v).toFixed(1)} m/s`;
}

// Photo background for the flight detail card — same treatment as
// the city weather card: the photo underlays the whole card under a
// dark gradient veil and fades in once its bytes actually arrive
// (the card itself opens instantly on its plain face; a photo that
// fails to load removes itself silently). Keyed by flight id at the
// call site so each aircraft gets a fresh fade. In 清屏 (clean) mode
// the veil all but lifts so the photo itself is what the user sees.
function FlightPhotoBg({ url, clean = false }: { url: string; clean?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(true)}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          background: clean
            ? "linear-gradient(180deg, rgba(5,10,17,0.04) 0%, rgba(5,10,17,0.10) 100%)"
            : "linear-gradient(180deg, rgba(5,10,17,0.52) 0%, rgba(5,10,17,0.66) 45%, rgba(5,10,17,0.88) 100%)",
        }}
      />
    </div>
  );
}

// Photo background for the city weather cards — the SAME loading
// discipline as the flight card's FlightPhotoBg: the card article
// itself carries a solid face (bg-[#070c12]/97 at the call sites),
// this layer paints the weather-toned gradient over it, and the
// photo FADES IN only once its bytes have actually arrived
// (opacity 0 until onLoad). The previous inline version rendered
// the <img> the moment its URL was known and the card had no solid
// face at all, so during the load the bright photo (or, before it,
// the bare globe texture through the translucent veil) sat directly
// under the text — the user's recording shows the Warsaw card's
// loading skeleton washed out over a bright skyline photo. The
// layer is pointer-events-none: it can never intercept a tap.
function CityPhotoBg({
  url,
  toneBg,
  onError,
}: {
  url: string | null;
  toneBg: string;
  onError?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      style={{ background: toneBg }}
    >
      {url && !broken && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setBroken(true);
            onError?.();
          }}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(5,10,17,0.52) 0%, rgba(5,10,17,0.66) 45%, rgba(5,10,17,0.88) 100%)",
        }}
      />
    </div>
  );
}

// Pill switch used by every toggle row in the panel.
function LayerSwitchPill({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        on ? "bg-[var(--accent)]" : "bg-white/15"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
          on ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </span>
  );
}

// Miniature marker previews: each data-layer row shows a tiny version
// of what the layer actually draws on the globe.
function LayerPreview({ kind }: { kind: keyof LayerState }) {
  if (kind === "weather") {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/30 bg-[#0a141f] text-[11px] font-medium text-white"
      >
        京
      </span>
    );
  }
  if (kind === "quakes") {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[2.5px] border-[#ffd166] bg-[#ffd166]/15"
      >
        <span className="h-2 w-2 rounded-full bg-[#ffd166]" />
      </span>
    );
  }
  if (kind === "events") {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[2.5px] border-[#ff8a3a] bg-[#0a141f] text-[10px] text-[#ff8a3a]"
      >
        ▲
      </span>
    );
  }
  if (kind === "clouds") {
    return (
      <span
        aria-hidden="true"
        className="h-7 w-7 shrink-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 38% 42%, rgba(255,255,255,0.95) 0%, rgba(210,228,242,0.55) 52%, rgba(210,228,242,0) 74%)",
        }}
      />
    );
  }
  if (kind === "aurora") {
    return (
      <span
        aria-hidden="true"
        className="h-7 w-7 shrink-0 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse 90% 55% at 50% 68%, rgba(96,255,176,0.95) 0%, rgba(64,230,150,0.45) 55%, rgba(64,230,150,0) 78%), radial-gradient(circle at 50% 30%, #16283f 0%, #0a141f 70%)",
        }}
      />
    );
  }
  if (kind === "stations") {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#7dd3fc]/60 bg-[#0a141f]"
      >
        <span className="h-2 w-2 rounded-full border-2 border-[#7dd3fc] bg-[#0a141f]" />
      </span>
    );
  }
  if (kind === "ships") {
    return (
      <span
        aria-hidden="true"
        className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/20 bg-[#0a141f]"
      >
        <ShipKindIcon kind="cargo" className="absolute top-0.5 left-1 h-3 w-3 text-[#9edcff]" />
        <ShipKindIcon kind="tanker" className="absolute top-0.5 right-1 h-3 w-3 text-[#73f2cc]" />
        <ShipKindIcon kind="passenger" className="absolute bottom-0.5 left-1 h-3 w-3 text-[#ebf7ff]" />
        <ShipKindIcon kind="fishing" className="absolute right-1 bottom-0.5 h-2.5 w-2.5 text-[#aef29e]" />
      </span>
    );
  }
  if (kind === "flights") {
    return (
      <span
        aria-hidden="true"
        className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/20 bg-[#0a141f]"
      >
        <FlightKindIcon kind="airliner" className="absolute top-0.5 left-1 h-3 w-3 text-[#c7f0ff]" />
        <FlightKindIcon kind="bizjet" className="absolute top-0.5 right-1 h-3 w-3 text-[#c9a7ff]" />
        <FlightKindIcon kind="prop" className="absolute bottom-0.5 left-1 h-3 w-3 text-[#ff8a6b]" />
        <FlightKindIcon kind="heli" className="absolute right-1 bottom-0.5 h-2.5 w-2.5 text-[#73f28c]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-7 w-7 shrink-0 rounded-full border border-white/20"
      style={{
        background:
          "linear-gradient(135deg, #3ae03a 0%, #d8e021 38%, #ff9d2e 62%, #ff3b30 82%, #c93bff 100%)",
        opacity: 0.9,
      }}
    />
  );
}

function LayerMenu(p: LayerMenuProps) {
  const open = p.open;
  const setOpen = p.onOpenChange;
  const activeData =
    (p.layers.weather ? 1 : 0) +
    (p.layers.quakes ? 1 : 0) +
    (p.layers.events ? 1 : 0) +
    (p.layers.clouds ? 1 : 0) +
    (p.layers.radar ? 1 : 0) +
    (p.layers.aurora ? 1 : 0) +
    (p.layers.stations ? 1 : 0) +
    (p.layers.flights ? 1 : 0) +
    (p.layers.ships ? 1 : 0) +
    (p.layers.webcams ? 1 : 0);
  const dataRows: Array<{
    k: keyof LayerState;
    label: string;
    desc: string;
  }> = [
    {
      k: "weather",
      label: "天气名牌",
      desc: "366 座内置城市 · 点名牌看当地天气",
    },
    {
      k: "quakes",
      label: "地震",
      desc: `USGS · 过去 24 小时 M4.5+${p.quakeCount != null ? ` · ${p.quakeCount} 条` : ""}`,
    },
    {
      k: "events",
      label: "自然事件",
      desc: `NASA EONET · 野火 / 火山 / 风暴 / 洪水${p.eventCount != null ? ` · ${p.eventCount} 条` : ""}`,
    },
    {
      k: "clouds",
      label: "卫星云图",
      desc: "三静止卫星圆盘合成：向日葵（亚洲/西太）+ GOES-West（东太/美洲西）+ GOES-East（美洲/大西洋）· NASA GIBS 真云图 + RainViewer 全球红外填补欧洲/非洲 · 约 10 分钟更新",
    },
    {
      k: "radar",
      label: "降水雷达",
      desc: "RainViewer · 近 2 小时雷达动画",
    },
    {
      k: "aurora",
      label: "极光",
      desc: `NOAA SWPC OVATION 预报${p.auroraNote ? ` · ${p.auroraNote}` : ""} · 按夜幕呈现（白天侧不可见）`,
    },
    {
      k: "stations",
      label: "空间站",
      desc: `${p.stationSource === "amsat" ? "备源 AMSAT 镜像 TLE（CelesTrak 从服务器不可达）" : "天宫 + ISS · CelesTrak TLE 实时传播"} · 含长沙过境预报`,
    },
    {
      k: "flights",
      label: "实时航班",
      desc: `${p.flightSource === "adsb.lol" ? "备源 adsb.lol（OpenSky 从服务器不可达）" : p.flightSource ? `来源 ${p.flightSource}` : "ADS-B 实时位置"}${p.flightCount != null ? ` · ${p.flightCount} 架` : ""} · 图标按机型分四类：纸飞机＝客机 · 喷气式＝商务机 · 螺旋桨＝螺旋桨机 · 旋翼＝直升机，按航向转向 · 默认关，开启才拉取`,
    },
    {
      k: "ships",
      label: "实时船舶",
      desc: `${p.shipSource === "aisstream.io" ? "主源 aisstream.io（全球 AIS 流）" : p.shipSource === "digitraffic" ? "备源 Digitraffic（波罗的海 · 主源 aisstream 暂不可达）" : p.shipSource ? `来源 ${p.shipSource}` : "AIS 实时位置"}${p.shipCount != null ? ` · ${p.shipCount} 艘` : ""} · 图标按船型分五类：货船 / 油轮 / 客船 / 渔船 / 其他，按航向转向 · AIS 为近岸广播，远洋稀疏 · 默认关，开启才拉取`,
    },
    {
      k: "webcams",
      label: "全球摄像头",
      desc: `Windy Webcams · 全球公开网络摄像头${p.webcamCount != null ? ` · ${p.webcamCount} 个` : ""} · 点开任意摄像头看它的实时画面 · 默认关，开启才拉取`,
    },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label="图层面板（图层、显示、全屏与自转）"
        onClick={() => setOpen(!open)}
        className={`flex h-11 w-11 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-colors duration-200 ${
          open
            ? "border-[var(--accent)] bg-black/70 text-[var(--accent)]"
            : "border-white/15 bg-black/55 text-white"
        }`}
      >
        {/* Classic stacked-layers glyph (the user's ask: a real
            layers button, not the old three-dots "more" icon) — the
            panel it opens is unchanged. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
          <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
          <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
        </svg>
      </button>
      {open && (
        <>
          {/* Click-catcher backdrop: a plain div, not a control —
              the panel's own ✕ is the one close button. */}
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/50 sm:bg-transparent"
          />
          {/* Panel face: deliberately NO entrance animation and a
              near-opaque face. The old build faded the panel in
              (card-in, opacity 0→1 over 240ms) at bg-black/65 — for
              the first frames the globe's labels and the bottom
              capsule bled straight through the rows, which read on
              the user's recording as the list rows ghosting /
              overlapping each other, and even settled, the place
              names behind the panel competed with the menu text.
              The panel now paints at full strength on frame one
              (bg #04090f at 95% + blur-2xl + a darker backdrop). */}
          <div
            role="dialog"
            aria-label="图层面板（图层与显示）"
            className="fixed inset-x-3 bottom-3 z-50 overflow-hidden rounded-2xl border border-white/20 bg-[#04090f]/95 shadow-2xl backdrop-blur-2xl max-sm:[bottom:max(0.75rem,env(safe-area-inset-bottom))] sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:top-full sm:mt-2 sm:w-[336px]"
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">图层</h2>
              <span className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
                {activeData > 0 ? `${activeData} 层开 · ` : ""}显示与功能
              </span>
              <button
                type="button"
                aria-label="关闭图层面板"
                onClick={() => setOpen(false)}
                className="font-console ml-auto inline-flex min-h-9 min-w-9 items-center justify-center border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <div
              data-scroll-allow
              className="console-scroll max-h-[76dvh] overflow-y-auto sm:max-h-[70dvh]"
            >
              {/* Data layers: switch rows with marker miniatures.
                  The basemap is satellite-only now (user's word in
                  the floating-layout edit) — no switcher section. */}
              <p className="font-console px-3.5 pt-3 text-[10px] tracking-[0.16em] text-[var(--dim)]">
                数据图层
              </p>
              <div className="px-1.5 pb-1">
                {dataRows.map((row) => (
                  <div key={row.k}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={p.layers[row.k]}
                      aria-label={`${row.label}图层开关`}
                      onClick={() => p.onToggleLayer(row.k)}
                      className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                    >
                      <LayerPreview kind={row.k} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {row.label}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--dim)]">
                          {row.desc}
                        </span>
                      </span>
                      <LayerSwitchPill on={p.layers[row.k]} />
                    </button>
                    {row.k === "radar" && p.layers.radar && (
                      <div className="mx-2 mb-2 rounded-md border border-white/10 bg-black/25 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label={
                              p.radarPlaying
                                ? "暂停雷达动画"
                                : "播放雷达动画"
                            }
                            aria-pressed={p.radarPlaying}
                            onClick={p.onToggleRadarPlay}
                            className="font-console inline-flex min-h-9 items-center border border-[var(--accent)]/60 px-2.5 py-1 text-[11px] text-[var(--accent)] transition-colors duration-200"
                          >
                            {p.radarPlaying ? "⏸ 暂停" : "▶ 播放"}
                          </button>
                          <span className="font-console text-[11px] text-[var(--dim)]">
                            {p.radarFrameCount > 0
                              ? `第 ${Math.min(p.radarIdx + 1, p.radarFrameCount)} / ${p.radarFrameCount} 帧${p.radarFrameTime ? ` · ${p.radarFrameTime}` : ""}`
                              : "正在加载雷达帧…"}
                          </span>
                        </div>
                        {p.radarFrameCount > 1 && (
                          <div
                            aria-hidden="true"
                            className="mt-2 flex gap-1"
                          >
                            {Array.from(
                              { length: p.radarFrameCount },
                              (_, i) => (
                                <span
                                  key={i}
                                  className={`h-1 flex-1 rounded-full ${
                                    i === p.radarIdx
                                      ? "bg-[var(--accent)]"
                                      : "bg-white/15"
                                  }`}
                                />
                              ),
                            )}
                          </div>
                        )}
                        <div className="mt-2.5 flex items-center gap-2">
                          <span className="font-console text-[11px] text-[var(--dim)]">
                            显示
                          </span>
                          <div
                            role="group"
                            aria-label="降水显示方式"
                            className="flex overflow-hidden rounded border border-white/15"
                          >
                            {(
                              [
                                ["soft", "柔和"],
                                ["crisp", "色标"],
                              ] as Array<[RainStyle, string]>
                            ).map(([v, label]) => (
                              <button
                                key={v}
                                type="button"
                                aria-pressed={p.radarStyle === v}
                                aria-label={`降水显示方式：${label}`}
                                onClick={() => p.onRadarStyle(v)}
                                className={`font-console min-h-8 px-3 py-1 text-[11px] transition-colors duration-200 ${
                                  p.radarStyle === v
                                    ? "bg-[var(--accent)] font-semibold text-black"
                                    : "bg-white/[0.04] text-[var(--dim)] hover:bg-white/10"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <span className="font-console text-[10px] text-[var(--dim)]">
                            {p.radarStyle === "soft"
                              ? "回波羽化成云团"
                              : "经典雷达色块"}
                          </span>
                        </div>
                        <div className="mt-2.5">
                          <div
                            aria-hidden="true"
                            className="h-1.5 rounded-full"
                            style={{
                              background:
                                "linear-gradient(90deg, #3ae03a 0%, #d8e021 38%, #ff9d2e 62%, #ff3b30 82%, #c93bff 100%)",
                            }}
                          />
                          <div className="font-console mt-1 flex justify-between text-[10px] text-[var(--dim)]">
                            <span>降水弱</span>
                            <span>降水强</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 追霞 section */}
              <p className="font-console px-3.5 pt-2 text-[10px] tracking-[0.16em] text-[var(--dim)]">
                追霞
              </p>
              <div className="px-1.5 pb-3.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.twilightOn}
                  aria-label="黄昏带高亮开关"
                  onClick={p.onToggleTwilight}
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="h-7 w-7 shrink-0 rounded-full border border-[#ff8a3a]/50"
                    style={{
                      background:
                        "linear-gradient(180deg, #2b4a73 0%, #b3546e 55%, #ff8a3a 100%)",
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      黄昏带高亮
                    </span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">
                      此刻 {p.twilightCount} 座城市正值黄昏
                    </span>
                  </span>
                  <LayerSwitchPill on={p.twilightOn} />
                </button>
                <div className="mt-1.5 flex gap-2 px-2">
                  <button
                    type="button"
                    aria-label="去看日落：飞到一座正处黄昏的城市"
                    onClick={() => {
                      p.onGoSunset();
                      setOpen(false);
                    }}
                    className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius)] bg-[#ff8a3a] px-3 py-2 text-xs font-semibold text-[#2b1402] transition-opacity duration-200 hover:opacity-90"
                  >
                    <SunsetIcon className="h-4 w-4" />
                    去看日落
                  </button>
                  <button
                    type="button"
                    aria-pressed={p.chaseOn}
                    aria-label="追霞接力开关：每约90秒自动跳往下一座更西的黄昏城市"
                    onClick={p.onToggleChase}
                    className={`font-console flex min-h-10 flex-1 items-center justify-center rounded-[var(--radius)] border px-3 py-2 text-xs transition-colors duration-200 ${
                      p.chaseOn
                        ? "border-[#ff8a3a] text-[#ffb37a]"
                        : "border-[var(--border)] text-[var(--dim)]"
                    }`}
                  >
                    追霞接力 {p.chaseOn ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

              {/* 时光机 section (v3.0) */}
              <p className="font-console px-3.5 pt-2 text-[10px] tracking-[0.16em] text-[var(--dim)]">
                时光机
              </p>
              <div className="px-1.5 pb-3.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.timeOn}
                  aria-label="时光机开关：在舞台底部打开 ±12 小时时间轴滑杆"
                  onClick={p.onToggleTime}
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--accent)]/50 bg-[#0a141f] text-[13px] text-[var(--accent)]"
                  >
                    ◐
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      时间轴滑杆
                    </span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">
                      {p.timeLabel}
                    </span>
                  </span>
                  <LayerSwitchPill on={p.timeOn} />
                </button>
              </div>

              {/* 显示 section: the controls the slimmed homepage no
                  longer carries as separate header buttons — the
                  stage keeps only this menu as its entry. */}
              <p className="font-console px-3.5 pt-2 text-[10px] tracking-[0.16em] text-[var(--dim)]">
                显示
              </p>
              <div className="px-1.5 pb-3.5">
                <button
                  type="button"
                  aria-label={p.fsMode ? "退出全屏" : "全屏显示地球仪"}
                  onClick={() => {
                    p.onFullscreen();
                    setOpen(false);
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/25 bg-[#0a141f] text-[13px] text-[var(--text)]"
                  >
                    ⛶
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {p.fsMode ? "退出全屏" : "全屏"}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">
                      {p.fsMode ? "返回普通界面" : "地球铺满整个舞台"}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-[var(--dim)]">›</span>
                </button>
                {!p.fsMode && (
                  <button
                    type="button"
                    aria-label="横屏全屏显示地球仪"
                    onClick={() => {
                      p.onLandscapeFs();
                      setOpen(false);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/25 bg-[#0a141f] text-[13px] text-[var(--text)]"
                    >
                      ⟳
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        横屏全屏
                      </span>
                      <span className="block truncate text-[11px] text-[var(--dim)]">
                        全屏并尽量横置屏幕
                      </span>
                    </span>
                    <span aria-hidden="true" className="text-[var(--dim)]">›</span>
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.spinOn}
                  aria-label="地球自转开关"
                  onClick={p.onToggleSpin}
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/25 bg-[#0a141f] text-[13px] text-[var(--accent)]"
                  >
                    ↻
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      地球自转
                    </span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">
                      静置时缓慢自西向东转动
                    </span>
                  </span>
                  <LayerSwitchPill on={p.spinOn} />
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.todayOpen}
                  aria-label="地球此刻面板开关（极值榜与地球今日）"
                  onClick={p.onToggleToday}
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--gold)]/50 bg-[#0a141f] text-[13px] text-[var(--gold)]"
                  >
                    ◐
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      地球此刻
                    </span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">
                      极值榜与地球今日
                    </span>
                  </span>
                  <LayerSwitchPill on={p.todayOpen} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<GlobeFocus | null>(null);
  // Rotation is OFF by default (user: 默认不要地球转动) — the menu
  // toggle turns it on explicitly when wanted.
  const [spinOn, setSpinOn] = useState(false);
  // Fullscreen has two layers: native (Fullscreen API) and a CSS
  // pseudo-fullscreen fallback. If the native path throws, is missing
  // (in-app webviews), or enters but leaves a broken/zero-size canvas
  // (the Android white screen), we degrade to pseudo mode — the same
  // chrome-free layout driven purely by state — instead of a blank page.
  const [nativeFs, setNativeFs] = useState(false);
  // Restored after an unexpected page reload (see FS_RESTORE_KEY):
  // the user was in immersive fullscreen when the webview restarted
  // the page, so they land back in fullscreen, not in the framed
  // layout — the "全屏自己退出来" report.
  const [fsRestored] = useState<boolean>(loadFsRestore);
  const [pseudoFs, setPseudoFs] = useState<boolean>(fsRestored);
  const fsMode = nativeFs || pseudoFs;
  // Per-device memory that the native fullscreen path is broken (see
  // FS_BROKEN_KEY) — when set, taps skip native entirely.
  const [nativeBroken, setNativeBroken] = useState<boolean>(loadNativeBroken);
  // Fallback timer + attempt token for the native request: some Android
  // webviews return a requestFullscreen() promise that NEVER settles
  // (the host app doesn't implement the fullscreen plumbing, so the
  // request is silently swallowed). Awaiting it — as the previous build
  // did — hangs the whole toggle: the tap looks completely dead, which
  // is exactly the "phone can't go fullscreen" report. The fallback now
  // races the request instead of awaiting it.
  const fsTimerRef = useRef(0);
  const fsAttemptRef = useRef(0);
  // Search capsule state (Google-Earth-style floating pill at the
  // top of the stage): the query text + whether the results
  // dropdown is open. Brought back at the user's word in the
  // floating-layout edit — it searches the built-in city library
  // by 中文 / English / country / region.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // 图层面板 open state, lifted out of LayerMenu: while the
  // panel is open the bottom floating capsule hides (the panel is a
  // bottom sheet on phones and its lowest rows were covered by the
  // capsule showing through — 2026-11-18 recording), mirroring how
  // the capsule already steps aside for detail cards.
  const [menuOpen, setMenuOpen] = useState(false);
  // Loading veil over the stage: shown until the globe's first frame
  // renders, and force-lifted after 9s no matter what — a page reload
  // (e.g. the host webview restarting under memory pressure) must
  // always land on the globe or a visible state within a bounded
  // time, never on an indefinite spinner.
  const [globeReady, setGlobeReady] = useState(false);
  useEffect(() => {
    if (globeReady) return;
    const t = window.setTimeout(() => setGlobeReady(true), 9000);
    return () => window.clearTimeout(t);
  }, [globeReady]);
  // Slow-load progress (user's ask: 加载超过五秒加一个进度条）: if the
  // veil is still up 5s after navigation start — performance.now()
  // is navigation-relative, so bundle download + parse + texture
  // time all count — the veil gains a progress bar. loadFrac is the
  // Globe's REAL texture progress (shared LoadingManager); until
  // the first report arrives the bar runs a CSS creep toward 85%
  // so it keeps moving without inventing a number.
  const [slowLoad, setSlowLoad] = useState(false);
  const [loadFrac, setLoadFrac] = useState<number | null>(null);
  useEffect(() => {
    if (globeReady) return;
    const remaining = 5000 - performance.now();
    if (remaining <= 0) {
      setSlowLoad(true);
      return;
    }
    const t = window.setTimeout(() => setSlowLoad(true), remaining);
    return () => window.clearTimeout(t);
  }, [globeReady]);
  // Deferred globe mount (edit #27, cold-open freeze): the Globe is
  // NOT part of the first commit. The first paint is the app shell +
  // the loading veil below (and, before any JS runs, the static boot
  // splash in index.html); only after two animation frames — i.e.
  // after that paint has actually happened — does the Globe mount and
  // its heavy init effect (WebGL context, geometry, label queues)
  // run. Previously the init effect ran in the same commit as the
  // first render, so the browser had nothing painted to show while
  // it blocked: the "卡住空白几秒" the user reported.
  const [globeMounted, setGlobeMounted] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setGlobeMounted(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [note, setNote] = useState<string | null>(
    fsRestored
      ? "页面刚自动重新加载过，已恢复到全屏显示；点「退出全屏」可返回。"
      : null,
  );
  // Fullscreen compact-panel modes: default compact, 展开详情 for the
  // full stat set, fully collapsed to a one-line city + temperature bar.
  const [fsExpanded, setFsExpanded] = useState(false);
  const [fsCollapsed, setFsCollapsed] = useState(false);
  // The non-library place a globe tap can select (prefecture /
  // county / raw point) — region drill-down now happens by tapping
  // the globe itself (the picker UI was removed in the cleanup).
  const [place, setPlace] = useState<PlaceSel | null>(null);
  // A photo URL that fails to load (stale cache entry) hides its <img>
  // so the card falls back to the clean weather-toned backdrop instead
  // of showing a broken-image glyph.
  const [imgBroken, setImgBroken] = useState(false);

  // ── v2.0 state ───────────────────────────────────────────────────
  const [layers, setLayers] = useState<LayerState>({
    weather: true,
    quakes: false,
    events: false,
    clouds: true,
    radar: false,
    aurora: false,
    stations: false,
    flights: false,
    ships: false,
    webcams: false,
  });
  const toggleLayer = (k: keyof LayerState) =>
    setLayers((prev) => ({ ...prev, [k]: !prev[k] }));
  // Selected earthquake / natural event (their detail cards replace
  // the weather card's slot; selecting a city clears them and back).
  const [selQuake, setSelQuake] = useState<GlobeQuake | null>(null);
  const [selEvent, setSelEvent] = useState<GlobeEvent | null>(null);
  // v3.0 selections: a tapped flight / space station.
  const [selFlight, setSelFlight] = useState<GlobeFlight | null>(null);
  // 清屏 (clean view) for the flight card: the id of the flight whose
  // card is showing photo-only. Keyed by flight id, so opening another
  // aircraft always starts un-cleaned.
  const [cleanFlightId, setCleanFlightId] = useState<string | null>(null);
  // Clean-mode restore, THIRD mechanism (the first two failed on
  // the user's phone and are deleted, not patched): #37 restored on
  // a pointer sequence + ghost-click swallow; #38 kept content
  // mounted but restored via the article's pointerup tap-anywhere
  // handler and armed a 1200ms onClickCapture swallow window after
  // every restore. Autopsy of #38: the 「恢复信息」 button's own
  // click could NEVER execute — a tap on it first bubbled
  // pointerup to the article, which stamped the restore timestamp,
  // and the click event that followed (milliseconds later, by
  // construction inside the 1200ms window) was eaten by the
  // article's capture-phase swallow before it could reach the
  // button. The only path that ever restored was the article's
  // pointerup handler, which depends on an un-cancelled pointer
  // sequence the host WebView does not reliably deliver (the app's
  // own global touchmove preventDefault can turn the gesture into
  // a pointercancel). So on the real device the button was dead.
  // THIS mechanism has no timing in it at all: no pointer handlers
  // on the card, no capture swallow, no timestamps, no debounce.
  // 清屏/恢复 only toggle the fields wrapper between hidden and
  // contents (content is never unmounted), the photo layer is
  // pointer-events-none, and 「恢复信息」 is a standalone real
  // <button> rendered last, at z-30 with its own pointer-events,
  // whose plain onClick clears the clean id — nothing stands
  // between the tap and the handler. The ship card below uses the
  // identical mechanism (it shared the broken one).
  const [selStation, setSelStation] = useState<GlobeStation | null>(null);
  // A tapped vessel (AIS ship layer): its detail card mirrors the
  // flight card, including the photo background and 清屏 mode.
  const [selShip, setSelShip] = useState<GlobeShip | null>(null);
  const [cleanShipId, setCleanShipId] = useState<string | null>(null);
  // A tapped webcam (Windy layer): the card's live image is resolved
  // per tap by the getWebcam query below (free-plan image links are
  // short-lived, so the layer payload carries no image URL).
  const [selWebcam, setSelWebcam] = useState<GlobeWebcam | null>(null);
  // 时光机 (v3.0): panel on/off, the shift in minutes (−720…+720),
  // and its play state (advances the shift until it reaches +12h).
  const [timeOn, setTimeOn] = useState(false);
  const [timeOffsetMin, setTimeOffsetMin] = useState(0);
  const [timePlaying, setTimePlaying] = useState(false);
  // Composed overlay canvases for the v3.0 layers.
  const [auroraFrame, setAuroraFrame] = useState<GlobeOverlayFrame | null>(null);
  const [geoCloudCanvas, setGeoCloudCanvas] = useState<HTMLCanvasElement | null>(null);
  const [finalCloudFrame, setFinalCloudFrame] = useState<GlobeOverlayFrame | null>(null);
  // 追霞： twilight band highlight + relay (auto-hop west every ~90s).
  const [twilightOn, setTwilightOn] = useState(false);
  const [chaseOn, setChaseOn] = useState(false);
  // 地球此刻 panel (extremes + today card) visibility. Closed by
  // default since the homepage cleanup — the globe is the first
  // thing on screen; the panel opens from the 图层 button.
  const [todayOpen, setTodayOpen] = useState(false);
  // Radar animation: current frame index + playing flag + the
  // composed equirect frames handed to the Globe.
  const [radarIdx, setRadarIdx] = useState(0);
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [radarStyle, setRadarStyle] = useState<RainStyle>(loadRadarStyle);
  const pickRadarStyle = (s: RainStyle) => {
    setRadarStyle(s);
    try {
      localStorage.setItem(RADAR_STYLE_KEY, s);
    } catch {
      /* private mode — the choice just won't persist */
    }
  };
  const [radarFrame, setRadarFrame] = useState<GlobeOverlayFrame | null>(null);
  const [cloudFrame, setCloudFrame] = useState<GlobeOverlayFrame | null>(null);

  const libCity = selectedId ? (CITY_BY_ID.get(selectedId) ?? null) : null;
  const selected: City | PlaceSel | null = place ?? libCity;
  const lastInteractAtRef = useRef(0);
  // The app root element: in fullscreen it doubles as the fullscreen
  // container the gesture guard below anchors to.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The scrollable shell (see the JSX at the bottom): a REAL
  // overflow-y:auto scroller whose content is only ~2px taller than
  // the viewport, with the stage position:sticky inside it.
  const shellRef = useRef<HTMLDivElement | null>(null);

  // One-second clock for the dual local/Beijing time readouts.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Pull-to-refresh guard (structural, round 3 — edge-aware; now an
  // auxiliary layer under round 6's document pin, see below): native
  // touch panning is refused by touch-action, and this handler
  // swallows the moves themselves. Round 2 swallowed every
  // touch drag outside [data-scroll-allow] but let drags INSIDE one
  // through unconditionally — and a pull-down that starts inside a card
  // already scrolled to its top edge chains straight past the scroller
  // to the host, arming its pull-to-refresh (the fullscreen report:
  // 全屏里往下拉还是刷新). Round 3 tracks the gesture from touchstart
  // and only lets an internal scroller consume a move it can actually
  // scroll with: finger moving up while the scroller can still scroll
  // down, or finger moving down while scrollTop > 0. A pull at the top
  // edge (or a push at the bottom edge) is preventDefaulted like every
  // other drag, and [data-scroll-allow] also carries
  // overscroll-behavior:none (theme.css) so no scroll chain escapes.
  useEffect(() => {
    let startY = 0;
    let startScroller: Element | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || e.touches.length !== 1) {
        startScroller = null;
        return;
      }
      startY = touch.clientY;
      const t = e.target as Element | null;
      startScroller =
        t && typeof t.closest === "function"
          ? t.closest("[data-scroll-allow]")
          : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startScroller && e.touches.length === 1) {
        const touch = e.touches[0];
        if (touch) {
          const dy = touch.clientY - startY;
          const sc = startScroller as HTMLElement;
          const canScroll =
            (dy < 0 &&
              sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) ||
            (dy > 0 && sc.scrollTop > 0);
          if (canScroll) return;
        }
      }
      e.preventDefault();
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  // Pull-to-refresh pin, round 6 — DOCUMENT-level (the strategy
  // flip the 2026-11-18 real-device recording forced): rounds 1–5
  // locked the document (position:fixed / overflow:hidden) and
  // pinned a private inner shell at ~1px, but the host WebView
  // judges "at top" from the DOCUMENT's own scroll position —
  // window.scrollY sat at 0 forever inside the fixed frame, the
  // host's pull-to-refresh kept arming, and a downward drag on the
  // globe reloaded the page (≈3s of black loading screen in the
  // recording). The document is no longer locked: the app content
  // is ~2px taller than the viewport (the shell spacer below, stage
  // sticky inside it), so the document itself owns a tiny real
  // scroll range, and this effect keeps window.scrollY pinned at
  // ≥1px — the scroll listener re-pins IMMEDIATELY when anything
  // settles it back to 0 (a programmatic scrollTo fires one more
  // scroll event at 1px and stops), with touchend/resize/visibility
  // re-pins as backstops. The host therefore never sees an at-top
  // document. In immersive fullscreen the shell element becomes the
  // scroller instead (fixed + overflow-y:auto), so it is pinned the
  // same way. Nothing visibly moves either way: the stage is
  // sticky, so the 1px rest offset never shows. The CSS locks that
  // remain (overscroll-behavior, touch-action, the touchmove guard
  // above) are auxiliary layers only — the pin is the mechanism.
  useEffect(() => {
    const shell = shellRef.current;
    const pin = () => {
      if (window.scrollY < 1) window.scrollTo(0, 1);
      if (shell && shell.scrollTop < 1 && shell.scrollHeight > shell.clientHeight) {
        shell.scrollTop = 1;
      }
    };
    pin();
    const onScroll = () => {
      // Re-pin the moment a scroller reaches its top edge.
      if (window.scrollY < 1) window.scrollTo(0, 1);
      if (shell && shell.scrollTop < 1 && shell.scrollHeight > shell.clientHeight) {
        shell.scrollTop = 1;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    shell?.addEventListener("scroll", onScroll, { passive: true });
    let t = 0;
    const onSettle = () => {
      window.clearTimeout(t);
      t = window.setTimeout(pin, 120);
    };
    document.addEventListener("touchend", onSettle, { passive: true });
    window.addEventListener("resize", onSettle);
    document.addEventListener("visibilitychange", onSettle);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
      shell?.removeEventListener("scroll", onScroll);
      document.removeEventListener("touchend", onSettle);
      window.removeEventListener("resize", onSettle);
      document.removeEventListener("visibilitychange", onSettle);
    };
  }, [fsMode]);

  const weather = useQuery({
    queryKey: ["weather", selected?.id ?? ""],
    queryFn: () =>
      api.getCityWeather({
        lat: selected!.lat,
        lng: selected!.lng,
        tz: selected!.tz,
      }),
    enabled: selected != null,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });

  const photo = useQuery({
    queryKey: ["photo", selected?.id ?? ""],
    queryFn: () =>
      api.getCityPhoto({ id: selected!.id, wiki: selected!.wiki, zh: selected!.zh }),
    // Places with no article title yet (a globe-tapped point still
    // waiting for its reverse-geocode name) skip the photo lookup.
    enabled: selected != null && selected.wiki.trim().length > 0,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // Photo for the tapped flight's card background: fetched only for
  // that one aircraft (the server resolves and caches it), never for
  // the layer as a whole. The card opens instantly without it; when
  // the photo lands it fades in behind the card's content.
  const flightPhoto = useQuery({
    queryKey: ["flight-photo", selFlight?.id ?? ""],
    queryFn: () =>
      api.getFlightPhoto({
        id: selFlight!.id,
        reg: selFlight!.reg,
        type: selFlight!.type,
      }),
    enabled: selFlight != null,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // Aircraft archive （运营方 / registry country) for the tapped
  // flight: resolved server-side from adsbdb's aircraft database by
  // transponder hex and cached there — only for this one aircraft,
  // only while its card is open (edit #37: replaces the 始发地/目的地
  // route lookup in the card's second row, per the user's steer;
  // the getFlightRoute action itself stays published but unused).
  const flightAircraft = useQuery({
    queryKey: ["flight-aircraft", selFlight?.id ?? ""],
    queryFn: () => api.getFlightAircraft({ id: selFlight!.id }),
    enabled: selFlight != null,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  const flightClean = selFlight != null && cleanFlightId === selFlight.id;

  // Mapillary street-level photo for the selected place: fetched
  // independently of the weather (its own query, its own loading and
  // empty states in StreetViewBlock) so a slow or empty street-view
  // lookup never delays or breaks the weather card.
  const streetView = useQuery({
    queryKey: ["streetview", selected?.id ?? ""],
    queryFn: () =>
      api.getStreetView({ lat: selected!.lat, lng: selected!.lng }),
    enabled: selected != null,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  // ── v2.0 data: all async, none of it blocks the globe ───────────
  // Live earthquakes + natural events (USGS / NASA EONET via the
  // server action, which degrades per-source with ok flags).
  const earthEvents = useQuery({
    queryKey: ["earth-events"],
    queryFn: () => api.getEarthEvents({}),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  // RainViewer frame index (tile host + past radar / satellite
  // frames); the tiles themselves are composed client-side.
  const rainMaps = useQuery({
    queryKey: ["rain-maps"],
    queryFn: () => api.getRainViewerMaps({}),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  // ── v3.0 data: every query is ENABLED ONLY while its layer is on —
  // none of it touches the network (or the first paint) otherwise.
  const auroraQ = useQuery({
    queryKey: ["aurora"],
    queryFn: () => api.getAurora({}),
    enabled: layers.aurora,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  const stationsQ = useQuery({
    queryKey: ["stations"],
    queryFn: () => api.getStations({}),
    enabled: layers.stations,
    staleTime: 20 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: layers.stations ? 30000 : false,
    retry: false,
  });
  const flightsQ = useQuery({
    queryKey: ["flights"],
    queryFn: () => api.getFlights({}),
    enabled: layers.flights,
    staleTime: 45 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: layers.flights ? 60000 : false,
    retry: false,
  });
  // Live vessels (AIS): same lazy discipline as flights — the query
  // runs only while the ship layer is on, refreshing every 90s (AIS
  // position reports are minutes apart for most vessels anyway).
  const shipsQ = useQuery({
    queryKey: ["ships"],
    queryFn: () => api.getShips({}),
    enabled: layers.ships,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: layers.ships ? 90000 : false,
    retry: false,
  });
  // Windy webcams: positions only, fetched while the layer is on
  // (the server caches its region sweep for 30 minutes; positions
  // are static, so no polling interval).
  const webcamsQ = useQuery({
    queryKey: ["webcams"],
    queryFn: () => api.getWebcams({}),
    enabled: layers.webcams,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
  // The tapped webcam's live image: resolved fresh per tap by the
  // server (free-plan image links live ~15 minutes). A 10-minute
  // staleTime keeps re-taps of the same camera instant while never
  // serving an expired link.
  const webcamDetail = useQuery({
    queryKey: ["webcam", selWebcam?.id ?? ""],
    queryFn: () => api.getWebcam({ id: selWebcam!.id }),
    enabled: selWebcam != null,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  // Photo for the tapped vessel's card background: resolved
  // server-side for that one ship only (Commons name match, else a
  // same-class photo), never pre-fetched for the layer.
  const shipPhoto = useQuery({
    queryKey: ["ship-photo", selShip?.id ?? ""],
    queryFn: () =>
      api.getShipPhoto({
        mmsi: selShip!.id,
        name: selShip!.name,
        kind: selShip!.kind,
      }),
    enabled: selShip != null,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  const shipClean = selShip != null && cleanShipId === selShip.id;
  // Global extremes over the whole library (two bulk Open-Meteo
  // calls server-side; the points list is the library itself).
  const extremePoints = useMemo(
    () => CITIES.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng })),
    [],
  );
  const extremes = useQuery({
    queryKey: ["global-extremes"],
    queryFn: () => api.getGlobalExtremes({ points: extremePoints }),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });

  // Reverse geocoding for a globe-tapped point: the card opens
  // instantly with the coordinates; the real place name (BigDataCloud,
  // via the server action) fills in when it lands.
  const isPoint = place?.id.startsWith("pt:") ?? false;
  const geocode = useQuery({
    queryKey: ["geocode", place?.id ?? ""],
    queryFn: () =>
      api.reverseGeocode({ lat: place!.lat, lng: place!.lng }),
    enabled: isPoint,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    const d = geocode.data;
    if (!d || !place || !place.id.startsWith("pt:")) return;
    if (place.zh !== "地图所选位置") return; // already named
    const name = d.name ?? d.region;
    setPlace({
      ...place,
      zh: name ?? "地图所选位置",
      en: name ?? "",
      country: d.country ?? "",
      region: d.region ?? "",
      wiki: d.name ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geocode.data]);

  // A new selection gets a fresh chance to show its photo.
  useEffect(() => {
    setImgBroken(false);
  }, [selected?.id]);

  const goToCity = (city: City) => {
    lastInteractAtRef.current = Date.now();
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setPlace(null);
    setSearchOpen(false);
    setQuery("");
    setSelectedId(city.id);
    setFocus({
      id: city.id,
      lat: city.lat,
      lng: city.lng,
      tier: city.tier,
      nonce: Date.now(),
    });
  };

  // A real place outside the library (a tapped prefecture / region
  // plate). Flies to it at the given depth and opens its weather
  // card.
  const goToPlace = (p: SubPlace, dist: number) => {
    lastInteractAtRef.current = Date.now();
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setSearchOpen(false);
    setQuery("");
    setSelectedId(null);
    setPlace({ ...p, capital: false });
    setFocus({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      tier: 3,
      nonce: Date.now(),
      dist,
    });
  };

  // Tap anywhere on the sphere: a place defined purely by its
  // coordinates. Weather comes from Open-Meteo with tz "auto"; the
  // name is reverse-geocoded (effect above) — until then, and for
  // nameless points like open ocean, the card shows the coordinates.
  const goToPoint = (lat: number, lng: number) => {
    lastInteractAtRef.current = Date.now();
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setSearchOpen(false);
    setQuery("");
    const id = `pt:${lat.toFixed(3)},${lng.toFixed(3)}`;
    setSelectedId(null);
    setPlace({
      id,
      zh: "地图所选位置",
      en: "",
      country: "",
      region: "",
      lat,
      lng,
      tz: "auto",
      wiki: "",
      capital: false,
    });
    setFocus({ id, lat, lng, tier: 3, nonce: Date.now(), dist: 1.9 });
  };

  const clearSelection = () => {
    setSelectedId(null);
    setPlace(null);
  };

  // ── v2.0 selection + sunset handlers ─────────────────────────────
  const flyToCoords = (id: string, lat: number, lng: number, dist: number) => {
    lastInteractAtRef.current = Date.now();
    setFocus({ id, lat, lng, tier: 3, nonce: Date.now(), dist });
  };

  const goToQuake = (q: GlobeQuake) => {
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setSelQuake(q);
    clearSelection();
    flyToCoords(`quake:${q.id}`, q.lat, q.lng, 2.3);
  };

  const goToEvent = (e: GlobeEvent) => {
    setSelQuake(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setSelEvent(e);
    clearSelection();
    flyToCoords(`event:${e.id}`, e.lat, e.lng, 2.3);
  };

  const goToFlight = (f: GlobeFlight) => {
    setSelQuake(null);
    setSelEvent(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(null);
    setSelFlight(f);
    clearSelection();
    flyToCoords(`flight:${f.id}`, f.lat, f.lng, 2.2);
  };

  const goToStation = (s: GlobeStation) => {
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelShip(null);
    setSelWebcam(null);
    setSelStation(s);
    clearSelection();
    flyToCoords(`station:${s.id}`, s.lat, s.lng, 2.6);
  };

  const goToShip = (s: GlobeShip) => {
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelWebcam(null);
    setSelShip(s);
    clearSelection();
    flyToCoords(`ship:${s.id}`, s.lat, s.lng, 2.2);
  };

  const goToWebcam = (w: GlobeWebcam) => {
    setSelQuake(null);
    setSelEvent(null);
    setSelFlight(null);
    setSelStation(null);
    setSelShip(null);
    setSelWebcam(w);
    clearSelection();
    flyToCoords(`webcam:${w.id}`, w.lat, w.lng, 2.2);
  };

  // 「去看日落」: turn the twilight band on and fly to the library
  // city whose sunset is at its best right now (solar-altitude
  // computed, evening side only — see solar.ts).
  const goToSunset = () => {
    setTwilightOn(true);
    const list = findTwilightCities(CITIES, new Date());
    const pick = list.find((x) => x.city.id !== selectedId) ?? list[0];
    if (pick) {
      goToCity(pick.city);
    } else {
      setNote("此刻内置城市里暂时没有正处黄昏的城市，过一会儿再试。");
    }
  };

  // ── v2.0 effects ─────────────────────────────────────────────────
  // 追霞接力： every ~90s, hop to the next twilight city WEST of the
  // current one (the terminator moves west as the Earth turns), so
  // the view stays inside the sunset band indefinitely.
  useEffect(() => {
    if (!chaseOn) return;
    const t = setInterval(() => {
      const list = findTwilightCities(CITIES, new Date());
      if (list.length === 0) return;
      const cur = selectedId ? CITY_BY_ID.get(selectedId) : null;
      let next = list[0];
      if (cur) {
        // Westward = smaller longitude (wrap at the antimeridian):
        // prefer the best-sunset city clearly west of the current.
        const west = list.filter((x) => {
          let d = cur.lng - x.city.lng;
          if (d < -180) d += 360;
          return d > 3 && x.city.id !== cur.id;
        });
        next = west[0] ?? list.find((x) => x.city.id !== cur.id) ?? list[0];
      }
      if (next && next.city.id !== selectedId) goToCity(next.city);
    }, 90000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaseOn, selectedId]);

  // Radar frames: default to the newest frame when the index lands;
  // compose the selected frame's tiles into an equirect canvas.
  const radarFrames = rainMaps.data?.ok ? rainMaps.data.radarPast : [];
  useEffect(() => {
    if (radarFrames.length > 0) {
      setRadarIdx(radarFrames.length - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rainMaps.data?.fetchedAt]);
  useEffect(() => {
    if (!layers.radar || !rainMaps.data?.ok || !rainMaps.data.host) {
      setRadarFrame(null);
      return;
    }
    const f = radarFrames[radarIdx];
    if (!f) return;
    let alive = true;
    void composeRainFrame(rainMaps.data.host, f.path, "radar", radarStyle).then(
      (cv) => {
        if (alive) setRadarFrame(cv ? { canvas: cv, key: f.time } : null);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.radar, rainMaps.data, radarIdx, radarStyle]);
  // Radar playback: advance through the past ~2h of frames.
  useEffect(() => {
    if (!radarPlaying || !layers.radar || radarFrames.length === 0) return;
    const t = setInterval(() => {
      setRadarIdx((i) => (i + 1) % radarFrames.length);
    }, 900);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarPlaying, layers.radar, radarFrames.length]);

  // Satellite cloud frame: compose the newest infrared frame when
  // RainViewer has one; when it has none, cloudFrame stays null and
  // the Globe falls back to its bundled cloud texture. With the time
  // machine shifted, the frame nearest the target time is composed
  // instead (when one exists within ~90 minutes of it).
  useEffect(() => {
    if (!layers.clouds || !rainMaps.data?.ok || !rainMaps.data.host) {
      setCloudFrame(null);
      return;
    }
    const frames = rainMaps.data.satellite;
    let f = frames[frames.length - 1];
    if (timeOn && timeOffsetMin !== 0 && frames.length > 0) {
      const target = (Date.now() + timeOffsetMin * 60000) / 1000;
      let bestF = frames[frames.length - 1];
      let bestD = Infinity;
      for (const fr of frames) {
        const d = Math.abs(fr.time - target);
        if (d < bestD) {
          bestD = d;
          bestF = fr;
        }
      }
      if (bestF && bestD <= 90 * 60) f = bestF;
    }
    if (!f) {
      setCloudFrame(null);
      return;
    }
    let alive = true;
    void composeRainFrame(rainMaps.data.host, f.path, "satellite").then(
      (cv) => {
        if (alive) setCloudFrame(cv ? { canvas: cv, key: f.time } : null);
      },
    );
    return () => {
      alive = false;
    };
  }, [layers.clouds, rainMaps.data, timeOn, timeOffsetMin]);

  // Multi-disk geostationary frame: composed from NASA GIBS tiles
  // (Himawari + GOES-West + GOES-East disks, see himawari.ts) the
  // first time the cloud layer is on, refreshed on a 5-minute tick
  // (the composer itself caches per 10-minute bucket). This is the
  // layer's primary imagery worldwide — the disks together cover
  // Asia-Pacific, the whole Pacific and the Americas/Atlantic.
  useEffect(() => {
    if (!layers.clouds) return;
    let alive = true;
    const load = () => {
      void composeGeoCloudFrame().then((cv) => {
        if (alive && cv) setGeoCloudCanvas(cv);
      });
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [layers.clouds]);

  // Final cloud frame = RainViewer global infrared mosaic with the
  // multi-disk geostationary frame drawn over it (both are full
  // equirect canvases; the disk canvas is transparent outside the
  // three disks, where the RainViewer mosaic — the only global
  // filler GIBS leaves for the Europe/Africa sector — shows
  // through). Either source alone still produces the layer.
  useEffect(() => {
    const rainCv = cloudFrame?.canvas ?? null;
    const himaCv = layers.clouds ? geoCloudCanvas : null;
    if (!rainCv && !himaCv) {
      setFinalCloudFrame(null);
      return;
    }
    if (!rainCv && himaCv) {
      setFinalCloudFrame({ canvas: himaCv, key: -2 });
      return;
    }
    if (rainCv && !himaCv) {
      setFinalCloudFrame(cloudFrame);
      return;
    }
    const out = document.createElement("canvas");
    out.width = 2048;
    out.height = 1024;
    const ctx = out.getContext("2d");
    if (!ctx || !rainCv || !himaCv) {
      setFinalCloudFrame(cloudFrame);
      return;
    }
    ctx.drawImage(rainCv, 0, 0, out.width, out.height);
    // The disk frame is drawn a hair under full strength: the two
    // sources image the same clouds a few minutes apart, and a
    // full-strength double draw stacks their edges into the hard,
    // blocky doubled contours the user reported over the Indian
    // Ocean. The merged frame then gets ONE feather pass of its
    // own, which melts the disk seams and those doubled edges —
    // neither exists in either source frame alone.
    ctx.globalAlpha = 0.94;
    ctx.drawImage(himaCv, 0, 0, out.width, out.height);
    ctx.globalAlpha = 1;
    setFinalCloudFrame({
      canvas: featherCanvas(out, 1),
      key: (cloudFrame?.key ?? 0) + 0.5,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudFrame, geoCloudCanvas, layers.clouds]);

  // Aurora field canvas from the OVATION grid (only while the layer
  // is on — the query above is disabled otherwise).
  useEffect(() => {
    if (!layers.aurora || !auroraQ.data?.ok) {
      setAuroraFrame(null);
      return;
    }
    // The builder night-masks the field at the forecast time (the
    // oval is only visible in darkness), falling back to "now".
    const when = auroraQ.data.forecastTime
      ? new Date(auroraQ.data.forecastTime)
      : new Date();
    const cv = buildAuroraCanvas(auroraQ.data.points, when);
    setAuroraFrame(
      cv
        ? {
            canvas: cv,
            key: auroraQ.data.forecastTime
              ? Date.parse(auroraQ.data.forecastTime)
              : 1,
          }
        : null,
    );
  }, [layers.aurora, auroraQ.data]);

  // Time machine × radar: while shifted, the radar shows the frame
  // nearest the target time and playback pauses (the frames only
  // cover the past ~2h; outside that the bar says so and the layer
  // keeps its nearest edge frame).
  useEffect(() => {
    if (!timeOn || !layers.radar || radarFrames.length === 0) return;
    const target = (Date.now() + timeOffsetMin * 60000) / 1000;
    let bestI = -1;
    let bestD = Infinity;
    radarFrames.forEach((f, i) => {
      const d = Math.abs(f.time - target);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    if (bestI >= 0 && bestD <= 15 * 60) {
      setRadarIdx(bestI);
      setRadarPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeOn, timeOffsetMin, layers.radar]);

  // Time machine playback: advance the shift +10 min every 300ms
  // until it reaches the +12h end, then stop.
  useEffect(() => {
    if (!timePlaying) return;
    const t = setInterval(() => {
      setTimeOffsetMin((v) => {
        const next = v + 10;
        if (next >= 720) {
          setTimePlaying(false);
          return 720;
        }
        return next;
      });
    }, 300);
    return () => clearInterval(t);
  }, [timePlaying]);

  // How many library cities are inside the twilight band right now
  // (recomputed once a minute off the 1s clock).
  const nowMinute = Math.floor(nowTick / 60000);
  const twilightCitiesNow = useMemo(
    () => findTwilightCities(CITIES, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowMinute],
  );

  // Persist the broken-native flag the moment it is learned.
  useEffect(() => {
    if (!nativeBroken) return;
    try {
      localStorage.setItem(FS_BROKEN_KEY, "1");
    } catch {
      // storage unavailable — the flag just won't persist
    }
  }, [nativeBroken]);

  // Keep the immersive-fullscreen restore flag in lockstep with the
  // mode itself: set on entry, cleared on any deliberate exit, so
  // only an UNEXPECTED page death (webview restart) ever restores.
  useEffect(() => {
    try {
      if (pseudoFs) {
        sessionStorage.setItem(FS_RESTORE_KEY, "1");
      } else {
        sessionStorage.removeItem(FS_RESTORE_KEY);
      }
    } catch {
      // storage unavailable — restore simply won't engage
    }
  }, [pseudoFs]);

  // Fullscreen gesture guard (suspect A, edit #22): in portrait
  // fullscreen the user kept getting a pull-down refresh even with the
  // framed-mode shell locked down — in that state the visible "page"
  // is the fullscreen container itself, so the defence is re-applied
  // AT that root while fsMode is on:
  //   (a) the root carries data-fs-root → theme.css pins it
  //       position:fixed / overflow:hidden / overscroll-behavior:none /
  //       touch-action:none (and :fullscreen gets the same for the
  //       native path, whose element is documentElement);
  //   (b) html/body overscroll is forced off inline for the duration
  //       (restored on exit) in case the SDK shell's own styles win
  //       the cascade;
  //   (c) a CAPTURE-phase guard on the root swallows every vertical
  //       pull the internal scrollers cannot themselves consume —
  //       capture runs before the document guard and before any child
  //       handler, so no fullscreen drag can bubble into a scroll
  //       chain that reaches the host. Internal scrollers keep
  //       scrolling under the same edge-aware rule as round 3.
  useEffect(() => {
    if (!fsMode) return;
    const root = rootRef.current;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOb = html.style.overscrollBehavior;
    const prevBodyOb = body.style.overscrollBehavior;
    html.style.overscrollBehavior = "none";
    body.style.overscrollBehavior = "none";
    if (!root) {
      return () => {
        html.style.overscrollBehavior = prevHtmlOb;
        body.style.overscrollBehavior = prevBodyOb;
      };
    }
    let startY = 0;
    let startScroller: Element | null = null;
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || e.touches.length !== 1) {
        startScroller = null;
        return;
      }
      startY = touch.clientY;
      const t = e.target as Element | null;
      startScroller =
        t && typeof t.closest === "function"
          ? t.closest("[data-scroll-allow]")
          : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startScroller && e.touches.length === 1) {
        const touch = e.touches[0];
        if (touch) {
          const dy = touch.clientY - startY;
          const sc = startScroller as HTMLElement;
          const canScroll =
            (dy < 0 &&
              sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) ||
            (dy > 0 && sc.scrollTop > 0);
          if (canScroll) return;
        }
      }
      e.preventDefault();
    };
    root.addEventListener("touchstart", onStart, {
      passive: true,
      capture: true,
    });
    root.addEventListener("touchmove", onMove, {
      passive: false,
      capture: true,
    });
    return () => {
      root.removeEventListener("touchstart", onStart, { capture: true });
      root.removeEventListener("touchmove", onMove, { capture: true });
      html.style.overscrollBehavior = prevHtmlOb;
      body.style.overscrollBehavior = prevBodyOb;
    };
  }, [fsMode]);

  const safeExitFullscreen = () => {
    fsAttemptRef.current = 0;
    window.clearTimeout(fsTimerRef.current);
    try {
      const p = document.exitFullscreen() as unknown as
        | Promise<void>
        | undefined;
      if (p && typeof p.catch === "function") void p.catch(() => {});
    } catch {
      // exitFullscreen may not exist / may throw in webviews — ignore.
    }
  };

  // Fire-and-forget native attempt. The returned promise may resolve,
  // reject, or (in broken webviews) never settle at all — callers must
  // race it against the fallback timer, never await it.
  const requestNativeFullscreen = (onRejected: () => void) => {
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | undefined;
      };
      const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
      if (typeof req !== "function") {
        onRejected();
        return;
      }
      const p = req.call(el) as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === "function") {
        void p.catch(onRejected);
      }
    } catch {
      onRejected();
    }
  };

  // Post-entry health check (desktop native path only — touch devices
  // never request native, see isCoarsePointer): native fullscreen
  // engaged, but is the canvas actually there? Two probes, at ~1000ms
  // and ~2200ms, deliberately AFTER the entry animation settles.
  //
  // What it must NEVER do again: exit the fullscreen itself. The
  // previous version force-exited on a "broken" verdict — but its
  // test was an OR-chain over transient size readings (a mid-
  // transition rect, a not-yet-resized buffer), so a healthy
  // fullscreen could be yanked away ~2s after entry, which is
  // precisely the "全屏时候会退出来" report. A size probe cannot
  // prove the composited frame is white anyway. So now: "broken"
  // requires the canvas to be missing or genuinely zero-size at
  // BOTH probes, and even then the check only records native as
  // unreliable on this device (the NEXT entry goes straight to
  // immersive) and tells the user — the current session stays
  // entirely under the user's control; the only exits left in the
  // app are the user's own taps and the system Esc/back.
  const verifyNativeFullscreen = (attempt: number) => {
    const probe = (late: boolean) => {
      if (fsAttemptRef.current !== attempt) return;
      if (!document.fullscreenElement) return;
      const cvs = document.querySelector("main canvas") as
        | HTMLCanvasElement
        | null;
      const r = cvs?.getBoundingClientRect();
      const broken =
        !cvs ||
        !r ||
        (r.width < 8 && r.height < 8) ||
        (cvs.width < 8 && cvs.height < 8);
      if (!broken) {
        if (!late) window.setTimeout(() => probe(true), 1200);
        return;
      }
      if (!late) {
        // One bad reading can be mid-transition noise — confirm with
        // the late probe before concluding anything.
        window.setTimeout(() => probe(true), 1200);
        return;
      }
      setNativeBroken(true);
      setNote("检测到原生全屏在本设备上可能显示异常：本次不自动退出，你可继续看或点「退出全屏」；下次点全屏将直接进兼容模式。");
    };
    window.setTimeout(() => probe(false), 1000);
  };

  // Fullscreen plumbing: native state is read from the document event;
  // every async fullscreen/orientation call is fully guarded so a
  // failure can never throw into the UI or the render loop.
  useEffect(() => {
    const onFsChange = () => {
      const on = Boolean(document.fullscreenElement);
      setNativeFs(on);
      if (on) {
        // Native fullscreen actually engaged (possibly after the
        // immersive fallback already fired): it wins — drop the
        // fallback timer and the pseudo layer so the two never stack,
        // and arm the render health check for the live attempt.
        window.clearTimeout(fsTimerRef.current);
        setPseudoFs(false);
        if (fsAttemptRef.current > 0) {
          verifyNativeFullscreen(fsAttemptRef.current);
        }
      }
    };
    const onFsError = () => {
      // The browser refused the request outright (policy / webview):
      // fall back immediately instead of waiting out the race timer.
      window.clearTimeout(fsTimerRef.current);
      if (fsAttemptRef.current > 0) setPseudoFs(true);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    document.addEventListener("fullscreenerror", onFsError);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      document.removeEventListener("fullscreenerror", onFsError);
    };
    // verifyNativeFullscreen is a stable per-render closure over refs
    // and setState only; the listener registration intentionally runs
    // once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockLandscape = () => {
    // Best-effort orientation lock — every failure is swallowed; the
    // worst case is plain fullscreen the user rotates manually.
    try {
      const o = screen.orientation as unknown as {
        lock?: (dir: string) => Promise<void> | undefined;
      };
      const p = o.lock?.("landscape");
      if (p && typeof p.catch === "function") void p.catch(() => {});
    } catch {
      // Orientation lock unsupported — plain fullscreen still applies.
    }
  };

  // Entering fullscreen always starts the data panel in compact mode.
  useEffect(() => {
    if (fsMode) {
      setFsExpanded(false);
      setFsCollapsed(false);
    }
  }, [fsMode]);

  // Notes auto-dismiss: in fullscreen the header (where the note used to
  // live) is hidden, so dismissal matters — a stale explanation must
  // not linger over the globe. The reload-restore banner ("页面刚自动
  // 重新加载过…") dismisses faster (~3s): after a host-forced reload
  // it only needs to explain the flash, not sit over the globe —
  // on device it lingered long enough to read as part of the fault.
  useEffect(() => {
    if (!note) return;
    const ms = note.includes("重新加载") ? 3000 : 6000;
    const t = window.setTimeout(() => setNote(null), ms);
    return () => window.clearTimeout(t);
  }, [note]);

  const enterFullscreen = (landscape: boolean) => {
    if (fsMode) {
      safeExitFullscreen();
      setPseudoFs(false);
      return;
    }
    const pseudoNote = landscape
      ? "已进入兼容全屏；把手机横过来即可横屏看地球，点「退出全屏」返回。"
      : "已进入兼容全屏（点「退出全屏」返回）。";
    // Touch-primary devices (the user's phone) skip native ENTIRELY:
    // there, native fullscreen engages and then presents a white
    // screen (host surface swap strands the WebGL canvas — the exact
    // symptom reported three rounds running), and no page-side probe
    // can see it, because the canvas element keeps a healthy size
    // while its composited surface is white. Immersive mode never
    // swaps any surface, so the globe keeps painting — a dependable
    // fullscreen beats a broken native one. Known-broken native paths
    // and contexts that forbid fullscreen take the same shortcut.
    if (nativeBroken || document.fullscreenEnabled === false || isCoarsePointer()) {
      setPseudoFs(true);
      setNote(
        isCoarsePointer()
          ? landscape
            ? "已进入兼容全屏：手机上系统全屏会白屏，兼容模式下地球照常显示；把手机横过来即可横屏，点「退出全屏」返回。"
            : "已进入兼容全屏：手机上系统全屏会白屏，兼容模式下地球照常显示，点「退出全屏」返回。"
          : pseudoNote,
      );
      return;
    }
    const attempt = fsAttemptRef.current + 1;
    fsAttemptRef.current = attempt;
    requestNativeFullscreen(() => {
      // Rejected (or API missing): fall back right away, unless this
      // attempt was superseded or fullscreen already engaged.
      if (fsAttemptRef.current !== attempt) return;
      if (document.fullscreenElement) return;
      window.clearTimeout(fsTimerRef.current);
      setPseudoFs(true);
      setNote(pseudoNote);
    });
    // Race the request: if it hasn't engaged within 800ms (hung
    // promise in a webview, silent swallow), immersive mode takes over
    // so the tap is never a no-op. If native engages later anyway,
    // the fullscreenchange handler above hands over to it.
    window.clearTimeout(fsTimerRef.current);
    fsTimerRef.current = window.setTimeout(() => {
      if (fsAttemptRef.current !== attempt) return;
      if (document.fullscreenElement) return;
      setPseudoFs(true);
      setNote(pseudoNote);
    }, 800);
    if (landscape) {
      // Orientation lock only makes sense once native fullscreen is
      // actually on; poll briefly for it instead of assuming.
      const startedAt = Date.now();
      const tryLock = () => {
        if (fsAttemptRef.current !== attempt) return;
        if (document.fullscreenElement) {
          lockLandscape();
          return;
        }
        if (Date.now() - startedAt < 2000) {
          window.setTimeout(tryLock, 250);
        }
      };
      window.setTimeout(tryLock, 250);
    }
    // The render health check is armed by the fullscreenchange handler
    // when native fullscreen actually engages (instantly or late).
  };

  const toggleFullscreen = () => enterFullscreen(false);
  const enterLandscapeFs = () => enterFullscreen(true);

  // Search capsule results: the built-in library matched on
  // 中文名 / English / 国家 / 地区， capped at 9 like before.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return CITIES.filter(
      (c) =>
        c.zh.includes(q) ||
        c.en.toLowerCase().includes(q) ||
        c.country.includes(q) ||
        c.region.includes(q),
    ).slice(0, 9);
  }, [query]);

  const w: Weather | undefined = weather.data;
  // Places whose zone is resolved from coordinates (US counties) show
  // the zone Open-Meteo returned; before it loads, fmtClock's guard
  // renders --:-- for the literal "auto".
  const localTz =
    selected == null
      ? "auto"
      : selected.tz === "auto"
        ? (w?.tzResolved ?? "auto")
        : selected.tz;
  const info = codeInfo(w?.weatherCode ?? null, w?.isDay ?? null);
  const toneBg =
    TONE_BG[w && w.ok ? info.tone : "cloudy"] ??
    TONE_BG.cloudy ??
    "linear-gradient(135deg,#33475e 0%,#4d6a8a 55%,#22344a 100%)";

  // ── v2.0 derived data for the 地球此刻 panel ──────────────────────
  const ex = extremes.data;
  const extremeRows: Array<{
    key: string;
    label: string;
    color: string;
    entry: { id: string; value: number } | null | undefined;
    format: (v: number) => string;
    emptyText: string;
  }> = [
    {
      key: "hottest",
      label: "最热",
      color: "#ff7b54",
      entry: ex?.hottest,
      format: (v) => `${v.toFixed(1)}°C`,
      emptyText: "—",
    },
    {
      key: "coldest",
      label: "最冷",
      color: "#7dd7ff",
      entry: ex?.coldest,
      format: (v) => `${v.toFixed(1)}°C`,
      emptyText: "—",
    },
    {
      key: "windiest",
      label: "风最大",
      color: "#bfe3ff",
      entry: ex?.windiest,
      format: (v) => `${v.toFixed(0)} km/h`,
      emptyText: "—",
    },
    {
      key: "rainiest",
      label: "降水最强",
      color: "#4cc3ff",
      entry: ex?.rainiest,
      format: (v) => `${v.toFixed(1)} mm`,
      emptyText: "全球暂无降水",
    },
    {
      key: "worstAir",
      label: "空气最差",
      color: "#ffa657",
      entry: ex?.worstAir,
      format: (v) => `PM2.5 ${v.toFixed(0)}`,
      emptyText: "暂无数据",
    },
    {
      key: "bestAir",
      label: "空气最好",
      color: "#3fb950",
      entry: ex?.bestAir,
      format: (v) => `PM2.5 ${v.toFixed(0)}`,
      emptyText: "暂无数据",
    },
  ];
  const ee = earthEvents.data;
  const todayBigQuake = ee
    ? [...ee.quakes].filter((q) => q.mag >= 6).sort((a, b) => b.mag - a.mag)[0]
    : undefined;
  const todayVolcano = ee?.events.find((e) => e.category === "volcanoes");
  const todayFire = ee?.events.find((e) => e.category === "wildfires");
  const todayStorm = ee?.events.find((e) => e.category === "severeStorms");
  // Twilight status of the selected place (for the weather cards).
  const twInfo = selected
    ? twilightInfo(selected.lat, selected.lng, new Date(nowTick))
    : null;
  const twilightLine =
    twInfo && twInfo.evening
      ? twInfo.inTwilight
        ? `黄昏进行中${
            twInfo.minutesOfTwilightLeft != null
              ? ` · 约 ${twInfo.minutesOfTwilightLeft} 分钟后天黑`
              : ""
          }`
        : twInfo.minutesToSunset != null && twInfo.minutesToSunset <= 60
          ? `约 ${twInfo.minutesToSunset} 分钟后日落`
          : null
      : null;
  const radarFrameTime =
    radarFrames[radarIdx] != null
      ? new Date(radarFrames[radarIdx]!.time * 1000).toLocaleTimeString(
          "zh-CN",
          { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false },
        )
      : null;

  // ── v3.0 derived ─────────────────────────────────────────────────
  const fmtBj = (iso: string) =>
    new Date(iso).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const fmtBjTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const COMPASS_ZH = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  const azZh = (az: number) =>
    COMPASS_ZH[Math.round((((az % 360) + 360) % 360) / 45) % 8] ?? "北";
  const auroraNote =
    layers.aurora && auroraQ.data?.ok && auroraQ.data.forecastTime
      ? `预报 ${fmtBjTime(auroraQ.data.forecastTime)}（北京）· 全图最高 ${auroraQ.data.maxProb}%`
      : layers.aurora && auroraQ.data && !auroraQ.data.ok
        ? "NOAA 暂时连不上"
        : null;
  // Aurora probability for the selected place (nearest OVATION grid
  // point), only meaningful while the aurora layer's data is loaded.
  const selAuroraProb =
    layers.aurora && auroraQ.data?.ok && selected
      ? auroraProbAt(auroraQ.data.points, selected.lat, selected.lng)
      : null;
  const stationPasses = stationsQ.data?.ok ? stationsQ.data.passes : [];
  const nextVisiblePass = (sid: string) =>
    stationPasses.find((p) => p.stationId === sid && p.visible) ??
    stationPasses.find((p) => p.stationId === sid) ??
    null;
  const selStationPass = selStation ? nextVisiblePass(selStation.id) : null;
  // Time machine readouts.
  const timeTarget = new Date(Date.now() + timeOffsetMin * 60000);
  const timeLabel = !timeOn
    ? "拖动看 ±12 小时的晨昏线与雷达回放"
    : timeOffsetMin === 0
      ? "现在 · 拖动滑杆回放过去或预演未来"
      : `${timeOffsetMin > 0 ? "+" : "−"}${Math.abs(timeOffsetMin)} 分钟 · ${timeTarget.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}（北京）`;
  const timeRadarNote =
    timeOn && layers.radar && radarFrames.length > 0
      ? (() => {
          const target = (Date.now() + timeOffsetMin * 60000) / 1000;
          const nearest = Math.min(
            ...radarFrames.map((f) => Math.abs(f.time - target)),
          );
          return nearest <= 15 * 60
            ? `雷达帧 ${radarFrameTime ?? ""}`
            : "该时刻无雷达帧（雷达只有近 2 小时）";
        })()
      : null;
  const timeTwilightCount = useMemo(
    () =>
      timeOn
        ? findTwilightCities(CITIES, new Date(Date.now() + timeOffsetMin * 60000)).length
        : 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeOn, timeOffsetMin, nowMinute],
  );

  return (
    // ── App shell (round 6, see the pin effect above) ────────────
    // In framed mode this is a PLAIN flow wrapper — no scroller of
    // its own. Its single child (the spacer) is exactly 2px taller
    // than the viewport and the stage inside is position:sticky;
    // top:0 at 100dvh, so the app LOOKS exactly as fixed as before
    // (the stage never drifts, 2px of range shows nothing), while
    // the DOCUMENT itself owns that 2px scroll range and its
    // scrollY rests pinned at ~1px — the state the host WebView
    // reads when deciding whether pull-to-refresh may arm (rounds
    // 1–5 pinned a private inner shell instead, and the document
    // stayed at 0, which is why the host kept refreshing). In
    // immersive fullscreen the shell takes fixed positioning
    // (inset-0, z-50) and becomes the scroller itself, so the same
    // 2px margin + pin survive fullscreen too.
    <div
      ref={shellRef}
      data-scroll-shell
      className={`w-full overscroll-none bg-[var(--bg)] ${
        pseudoFs ? "fixed inset-0 z-50 h-dvh overflow-y-auto" : "relative"
      }`}
    >
      <div className="relative bg-[var(--bg)]" style={{ height: "calc(100dvh + 2px)" }}>
    <div
      ref={rootRef}
      data-fs-root={fsMode ? "true" : undefined}
      style={
        // Gesture lock (round 5, ALWAYS on — it used to apply only
        // in fullscreen): touch-action:none on the stage root means
        // the browser never claims a drag that starts anywhere on
        // the stage (globe, floating capsules, chips, card faces)
        // as a native pan/scroll, so no gesture can be turned into
        // a scroll that chains to the host's pull-to-refresh. The
        // only native touch scrolling left is inside
        // [data-scroll-allow] containers, which opt back in with
        // touch-action:pan-y (theme.css) — per the touch-action
        // intersection rule, ancestors above a scroll container do
        // not constrain gestures handled by that container — and
        // those containers carry overscroll-behavior:none, so
        // their edge overscroll cannot chain out either.
        { touchAction: "none", overscrollBehavior: "none" }
      }
      className="sticky top-0 flex h-dvh flex-col overflow-hidden overscroll-none bg-[var(--bg)] text-[var(--text)]"
    >
      {/* ── Globe stage ──────────────────────────────────────────── */}
      <main className="relative min-h-0 flex-1">
        {globeMounted && (
        <Globe
          activeId={selected?.id ?? null}
          focus={focus}
          autoRotate={spinOn}
          layer="satellite"
          immersive={fsMode}
          quakes={earthEvents.data?.quakes ?? []}
          events={earthEvents.data?.events ?? []}
          showQuakes={layers.quakes}
          showEvents={layers.events}
          showWeather={layers.weather}
          twilightOn={twilightOn}
          radarFrame={layers.radar ? radarFrame : null}
          cloudFrame={layers.clouds ? finalCloudFrame : null}
          cloudOn={layers.clouds}
          auroraFrame={layers.aurora ? auroraFrame : null}
          auroraOn={layers.aurora}
          stations={stationsQ.data?.ok ? stationsQ.data.stations : []}
          showStations={layers.stations}
          flights={flightsQ.data?.ok ? flightsQ.data.flights : []}
          showFlights={layers.flights}
          ships={shipsQ.data?.ok ? shipsQ.data.ships : []}
          showShips={layers.ships}
          webcams={webcamsQ.data?.ok ? webcamsQ.data.webcams : []}
          showWebcams={layers.webcams}
          timeShiftMin={timeOn ? timeOffsetMin : 0}
          onQuakeClick={goToQuake}
          onEventClick={goToEvent}
          onStationClick={goToStation}
          onFlightClick={goToFlight}
          onShipClick={goToShip}
          onWebcamClick={goToWebcam}
          onFirstFrame={() => setGlobeReady(true)}
          onLoadProgress={(f) => {
            if (!globeReady) {
              setLoadFrac((prev) => (prev === null ? f : Math.max(prev, f)));
            }
          }}
          onCityClick={(id) => {
            const c = CITY_BY_ID.get(id);
            if (c) goToCity(c);
          }}
          onAdminClick={(p) => goToPlace(p, 1.5)}
          onPointClick={goToPoint}
          onLevelChange={() => {}}
          onInteract={() => {
            lastInteractAtRef.current = Date.now();
          }}
        />
        )}
        {/* Bounded loading veil: covers the stage until the globe is
            mounted AND its first frame has rendered (or the 9s
            force-lift in state above). Edit #27: it is also the
            React-side half of the cold-open fix — it belongs to the
            FIRST commit (the Globe mounts two frames later), so the
            app name + spinner are what the first paint shows instead
            of a frozen blank; the static boot splash in index.html
            covers the span before that. After an unexpected page
            reload this is the difference between "a labelled loading
            view that lands on the globe" and the bare black spinner
            the user reported. */}
        {(!globeMounted || !globeReady) && (
          <div
            role="status"
            aria-label="地球仪正在加载"
            className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black"
          >
            <img
              src={earthDaySmUrl}
              alt=""
              className="h-28 w-28 animate-pulse rounded-full object-cover opacity-80"
              style={{ objectPosition: "62% 50%" }}
            />
            <p className="font-console text-sm font-semibold tracking-[0.22em] text-[var(--text)]">
              地球Online · 全球天气
            </p>
            <div
              aria-hidden="true"
              className="boot-spinner h-8 w-8 rounded-full"
            />
            <p className="font-console text-xs tracking-[0.18em] text-[var(--dim)]">
              正在加载地球…
            </p>
            {slowLoad && (
              <div className="flex w-56 max-w-[70vw] flex-col items-center gap-2">
                <div
                  role="progressbar"
                  aria-label="地球加载进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    loadFrac !== null ? Math.round(loadFrac * 100) : undefined
                  }
                  className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                >
                  {loadFrac !== null ? (
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                      style={{
                        width: `${Math.max(4, Math.round(loadFrac * 100))}%`,
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="load-creep-bar h-full rounded-full bg-[var(--accent)]"
                    />
                  )}
                </div>
                <p className="font-console text-[11px] tracking-[0.14em] text-[var(--dim)]">
                  {loadFrac !== null
                    ? `加载较慢 · 地球纹理已加载 ${Math.round(loadFrac * 100)}%`
                    : "加载较慢，正在继续…"}
                </p>
              </div>
            )}
          </div>
        )}
        {/* ── Floating top bar (Google-Earth layout): the globe
            fills the whole stage over a pure-black space backdrop;
            the only top-edge elements are a dark-glass search
            capsule (left) and the round layers button (right,
            framed mode — fullscreen keeps its own stack). No
            header bar, no panel backing behind the globe. */}
        {!(fsMode && selected) && (
        <div className="absolute top-3 left-3 z-30 w-[min(330px,calc(100vw-5.75rem))] [top:max(0.75rem,env(safe-area-inset-top))] [left:max(0.75rem,env(safe-area-inset-left))]">
          <div className="flex h-11 items-center gap-2 rounded-full border border-white/15 bg-black/55 pr-1.5 pl-4 shadow-lg backdrop-blur-md">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-[18px] w-[18px] shrink-0 text-white/70"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.8-3.8" />
            </svg>
            <input
              type="search"
              value={query}
              aria-label="搜索城市或地区（中文或英文名）"
              placeholder="搜索城市 / 地区，或点地球任意位置"
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/45 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
                className="font-console flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs text-white/70 transition-colors duration-200 hover:bg-white/10"
              >
                ✕
              </button>
            )}
          </div>
          {searchOpen && query.trim().length > 0 && (
            <ul
              aria-label="城市搜索结果"
              data-scroll-allow
              className="console-scroll absolute inset-x-0 top-full mt-2 max-h-72 overflow-y-auto rounded-2xl border border-white/12 bg-black/70 shadow-2xl backdrop-blur-xl"
            >
              {searchResults.length === 0 ? (
                <li className="px-4 py-3 text-sm text-white/55">
                  未找到「{query.trim()}」— 试试英文名或国家，如 Tokyo / 巴黎 / 埃及
                </li>
              ) : (
                searchResults.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-label={`飞往${c.zh}`}
                      onClick={() => goToCity(c)}
                      className="flex min-h-11 w-full items-baseline gap-2 px-4 py-2.5 text-left transition-colors duration-200 hover:bg-white/[0.06]"
                    >
                      <span className="text-sm font-medium text-white">{c.zh}</span>
                      <span className="font-console text-[11px] text-white/55">
                        {c.en} · {c.country}
                        {c.country === "中国" ? ` · ${c.region}` : ""}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        )}
        {!fsMode && (
          <div className="absolute top-3 right-3 z-30 [top:max(0.75rem,env(safe-area-inset-top))] [right:max(0.75rem,env(safe-area-inset-right))]">
            <LayerMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              layers={layers}
              onToggleLayer={toggleLayer}
              quakeCount={ee?.quakesOk ? ee.quakes.length : null}
              eventCount={ee?.eventsOk ? ee.events.length : null}
              auroraNote={auroraNote}
              flightCount={flightsQ.data?.ok ? flightsQ.data.count : null}
              flightSource={flightsQ.data?.ok ? flightsQ.data.source : null}
              shipCount={shipsQ.data?.ok ? shipsQ.data.count : null}
              shipSource={shipsQ.data?.ok ? shipsQ.data.source : null}
              webcamCount={webcamsQ.data?.ok ? webcamsQ.data.count : null}
              stationSource={stationsQ.data?.ok ? stationsQ.data.source : null}
              fsMode={fsMode}
              onFullscreen={toggleFullscreen}
              onLandscapeFs={enterLandscapeFs}
              spinOn={spinOn}
              onToggleSpin={() => setSpinOn((v) => !v)}
              todayOpen={todayOpen}
              onToggleToday={() => setTodayOpen((v) => !v)}
              timeOn={timeOn}
              onToggleTime={() => setTimeOn((v) => !v)}
              timeLabel={timeLabel}
              radarFrameCount={radarFrames.length}
              radarIdx={radarIdx}
              radarPlaying={radarPlaying}
              onToggleRadarPlay={() => setRadarPlaying((v) => !v)}
              radarStyle={radarStyle}
              onRadarStyle={pickRadarStyle}
              radarFrameTime={radarFrameTime}
              twilightOn={twilightOn}
              onToggleTwilight={() => setTwilightOn((v) => !v)}
              chaseOn={chaseOn}
              onToggleChase={() => {
                setChaseOn((v) => !v);
                if (!chaseOn) {
                  setTwilightOn(true);
                  goToSunset();
                }
              }}
              onGoSunset={goToSunset}
              twilightCount={twilightCitiesNow.length}
            />
          </div>
        )}

        {/* Layer failure hint: a failed source hides its layer
            silently + this one small floating chip, never an error
            panel. */}
        {((layers.quakes && earthEvents.data && !earthEvents.data.quakesOk) ||
          (layers.events && earthEvents.data && !earthEvents.data.eventsOk) ||
          ((layers.radar || layers.clouds) &&
            rainMaps.data &&
            !rainMaps.data.ok) ||
          (layers.ships && shipsQ.data && !shipsQ.data.ok) ||
          (layers.webcams && webcamsQ.data && !webcamsQ.data.ok) ||
          (layers.flights && flightsQ.data && !flightsQ.data.ok) ||
          (layers.stations && stationsQ.data && !stationsQ.data.ok) ||
          (layers.aurora && auroraQ.data && !auroraQ.data.ok) ||
          (layers.radar &&
            rainMaps.data?.ok &&
            rainMaps.data.radarPast.length === 0)) && (
          <p className="font-console pointer-events-none absolute top-[4.5rem] left-1/2 z-20 w-max max-w-[92vw] -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-3.5 py-1.5 text-center text-[11px] text-white/65 backdrop-blur-md">
            {layers.quakes && earthEvents.data && !earthEvents.data.quakesOk
              ? "地震数据暂不可用（USGS 暂时连不上），该图层已隐藏。 "
              : ""}
            {layers.events && earthEvents.data && !earthEvents.data.eventsOk
              ? "自然事件数据暂不可用（NASA EONET 暂时连不上），该图层已隐藏。 "
              : ""}
            {(layers.radar || layers.clouds) && rainMaps.data && !rainMaps.data.ok
              ? "云层/雷达数据暂不可用（RainViewer 暂时连不上），相关图层已隐藏。"
              : ""}
            {layers.radar &&
            rainMaps.data?.ok &&
            rainMaps.data.radarPast.length === 0
              ? "RainViewer 当前没有可用的雷达帧，雷达图层已隐藏。"
              : ""}
            {layers.ships && shipsQ.data && !shipsQ.data.ok
              ? " 船舶数据暂不可用（AIS 接口暂时连不上），船舶图层已隐藏。"
              : ""}
            {layers.webcams && webcamsQ.data && !webcamsQ.data.ok
              ? " 摄像头数据暂不可用（Windy 暂时连不上），摄像头图层已隐藏。"
              : ""}
            {layers.flights && flightsQ.data && !flightsQ.data.ok
              ? " 航班数据暂不可用（ADS-B 接口暂时连不上），航班图层已隐藏。"
              : ""}
            {layers.stations && stationsQ.data && !stationsQ.data.ok
              ? " 空间站数据暂不可用（轨道数据暂时连不上），空间站图层已隐藏。"
              : ""}
            {layers.aurora && auroraQ.data && !auroraQ.data.ok
              ? " 极光数据暂不可用（NOAA 暂时连不上），极光图层已隐藏。"
              : ""}
          </p>
        )}

        {/* ── 长沙空间站过境预报 (v3.0): visible while the station
            layer is on. Next visible pass per station (or the next
            pass at all, marked 不可见 when none is visible). */}
        {layers.stations && stationsQ.data?.ok && (
          <section
            aria-label="长沙空间站过境预报"
            className={`card-in absolute bottom-3 left-3 z-20 w-[min(320px,84vw)] rounded-lg border border-[var(--border)] bg-[#070c12]/92 px-3 py-2.5 shadow-2xl backdrop-blur-md ${
              selected || selQuake || selEvent || selFlight || selStation || selShip || selWebcam
                ? "max-sm:hidden"
                : ""
            }`}
          >
            <h2 className="flex items-baseline gap-2 text-sm font-semibold">
              长沙过境预报
              <span className="font-console text-[10px] font-normal text-[var(--dim)]">
                未来 72 小时 · 高度角 &gt; 10°
              </span>
            </h2>
            <ul className="mt-1.5 space-y-1.5">
              {(stationsQ.data?.stations ?? []).map((s) => {
                const p = nextVisiblePass(s.id);
                return (
                  <li key={s.id} className="text-xs leading-relaxed">
                    <span
                      className="font-console mr-1.5 px-1 py-0.5 text-[10px] font-bold"
                      style={{
                        background: s.id === "css" ? "#fda4af" : "#7dd3fc",
                        color: "#0a1017",
                      }}
                    >
                      {s.id === "css" ? "天宫" : "ISS"}
                    </span>
                    {p ? (
                      <>
                        {fmtBj(p.peak)}（北京）最高 {p.maxEl}° ·{" "}
                        {azZh(p.riseAz)}升 {azZh(p.setAz)}落 ·{" "}
                        {p.visible ? (
                          <span className="text-[#7dffb0]">肉眼可见</span>
                        ) : (
                          <span className="text-[var(--dim)]">本次不可见（天光亮或站体在地影中）</span>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--dim)]">72 小时内无过境</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="font-console mt-1.5 text-[10px] text-[var(--dim)]">
              {stationsQ.data?.source === "amsat"
                ? "AMSAT 镜像 TLE（CelesTrak 备源）"
                : "CelesTrak TLE"}{" "}
              · SGP4 传播 · 点球上的站名看实时位置
            </p>
          </section>
        )}

        {/* ── 时光机滑杆 (v3.0): ±12h. The terminator follows the
            shifted sun (Globe prop), radar/satellite frames snap to
            the nearest real frame; readouts say what has no data. */}
        {timeOn && (
          <section
            aria-label="时光机：时间轴滑杆"
            className="card-in absolute top-[4.75rem] left-1/2 z-30 w-[min(580px,94vw)] -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[#070c12]/94 px-3.5 py-2.5 shadow-2xl backdrop-blur-md"
          >
            <div className="flex items-center gap-2">
              <span className="font-console text-[11px] tracking-[0.14em] text-[var(--accent)]">
                时光机
              </span>
              <span className="font-console text-xs tabular-nums">
                {timeOffsetMin === 0
                  ? "现在"
                  : `${timeTarget.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}（北京）`}
              </span>
              <span className="font-console ml-auto text-[11px] text-[var(--dim)]">
                {timeOffsetMin !== 0 &&
                  `${timeOffsetMin > 0 ? "+" : "−"}${Math.abs(timeOffsetMin)} 分钟`}
              </span>
              <button
                type="button"
                aria-label={timePlaying ? "暂停时光机播放" : "播放时光机（时间向前推进）"}
                aria-pressed={timePlaying}
                onClick={() => setTimePlaying((v) => !v)}
                className="font-console inline-flex min-h-9 items-center border border-[var(--accent)]/60 px-2.5 py-1 text-[11px] text-[var(--accent)] transition-colors duration-200"
              >
                {timePlaying ? "⏸ 暂停" : "▶ 播放"}
              </button>
              <button
                type="button"
                aria-label="回到现在"
                onClick={() => {
                  setTimeOffsetMin(0);
                  setTimePlaying(false);
                }}
                className="font-console inline-flex min-h-9 items-center border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--text)] transition-colors duration-200"
              >
                回到现在
              </button>
              <button
                type="button"
                aria-label="关闭时光机"
                onClick={() => {
                  setTimeOn(false);
                  setTimePlaying(false);
                  setTimeOffsetMin(0);
                }}
                className="font-console inline-flex min-h-9 min-w-9 items-center justify-center border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <input
              type="range"
              min={-720}
              max={720}
              step={10}
              value={timeOffsetMin}
              aria-label="时间偏移（分钟，−12 小时到 +12 小时）"
              onChange={(e) => {
                setTimePlaying(false);
                setTimeOffsetMin(Number(e.target.value));
              }}
              className="mt-2 w-full accent-[var(--accent)]"
            />
            <div className="font-console mt-1 flex flex-wrap gap-x-3 text-[10px] text-[var(--dim)]">
              <span>−12h</span>
              <span>晨昏线按该时刻的太阳位置</span>
              <span>雷达回放仅覆盖近 2 小时 · 云图取数据源最近帧</span>
              <span>该时刻 {timeTwilightCount} 座城市正值黄昏</span>
              {timeRadarNote && <span>{timeRadarNote}</span>}
              <span className="ml-auto">+12h</span>
            </div>
          </section>
        )}

        {/* ── 地球此刻：极值榜 + 地球今日 (v2.0) ─────────────────── */}
        {!fsMode && todayOpen && (
          <section
            aria-label="地球此刻：全球极值榜与今日大事"
            className="card-in absolute top-16 left-3 z-20 flex max-h-[min(58%,calc(100%-6.5rem))] w-[min(300px,82vw)] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[#070c12]/92 shadow-2xl backdrop-blur-md sm:top-[4.5rem]"
          >
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
              <h2 className="text-sm font-semibold">地球此刻</h2>
              <span className="font-console text-[10px] text-[var(--dim)]">
                {ex?.fetchedAt
                  ? `${new Date(ex.fetchedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })} 更新（北京）`
                  : ""}
              </span>
              <button
                type="button"
                aria-label="刷新极值榜与今日大事"
                onClick={() => {
                  void extremes.refetch();
                  void earthEvents.refetch();
                }}
                className="font-console ml-auto inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] transition-colors duration-200"
              >
                ⟳ 刷新
              </button>
              <button
                type="button"
                aria-label="收起地球此刻面板"
                onClick={() => setTodayOpen(false)}
                className="font-console inline-flex min-h-9 min-w-9 items-center justify-center border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <div data-scroll-allow className="console-scroll min-h-0 overflow-y-auto px-3 py-2">
              <p className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
                极值榜 · {CITIES.length} 城此刻实况
              </p>
              {extremes.isPending && (
                <p className="font-console py-2 text-[11px] text-[var(--dim)]">
                  正在计算全球极值…
                </p>
              )}
              {(extremes.isError || (ex && !ex.ok)) && (
                <p className="font-console py-2 text-[11px] text-[var(--dim)]">
                  {ex?.quotaExceeded
                    ? "极值数据暂不可用（天气服务今日调用额度已用完），点上方刷新重试。"
                    : "极值数据暂不可用（天气服务暂时连不上），点上方刷新重试。"}
                </p>
              )}
              {ex && ex.ok && (
                <ul className="mt-1.5 space-y-1">
                  {extremeRows.map((row) => {
                    const city = row.entry
                      ? CITY_BY_ID.get(row.entry.id)
                      : undefined;
                    return (
                      <li key={row.key}>
                        {row.entry && city ? (
                          <button
                            type="button"
                            aria-label={`飞往${row.label}的城市${city.zh}`}
                            onClick={() => goToCity(city)}
                            className="flex min-h-10 w-full items-center gap-2 border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors duration-200 hover:border-[var(--accent)]"
                          >
                            <span
                              aria-hidden="true"
                              className="h-6 w-1 shrink-0 rounded-full"
                              style={{ background: row.color }}
                            />
                            <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                              {row.label}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {city.zh}
                            </span>
                            <span className="text-sm font-semibold tabular-nums">
                              {row.format(row.entry.value)}
                            </span>
                          </button>
                        ) : (
                          <p className="flex min-h-10 items-center gap-2 border border-white/5 px-2 py-1.5 text-[var(--dim)]">
                            <span
                              aria-hidden="true"
                              className="h-6 w-1 shrink-0 rounded-full"
                              style={{ background: row.color }}
                            />
                            <span className="font-console shrink-0 text-[11px]">
                              {row.label}
                            </span>
                            <span className="text-xs">{row.emptyText}</span>
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="font-console mt-3 text-[10px] tracking-[0.14em] text-[var(--dim)]">
                地球今日
              </p>
              {earthEvents.isPending && (
                <p className="font-console py-2 text-[11px] text-[var(--dim)]">
                  正在拉取今日大事…
                </p>
              )}
              {ee && (
                <ul className="mt-1.5 space-y-1">
                  <li>
                    {todayBigQuake ? (
                      <button
                        type="button"
                        aria-label={`查看今日最强地震：${todayBigQuake.place}`}
                        onClick={() => goToQuake(todayBigQuake)}
                        className="flex min-h-10 w-full items-center gap-2 border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors duration-200 hover:border-[var(--accent)]"
                      >
                        <span className="font-console shrink-0 border border-[#ff7b54]/50 px-1.5 py-0.5 text-[10px] text-[#ff9d7a]">
                          地震
                        </span>
                        <span className="min-w-0 flex-1 text-sm leading-snug line-clamp-2">
                          M{todayBigQuake.mag.toFixed(1)} · {todayBigQuake.place}
                        </span>
                      </button>
                    ) : (
                      <p className="flex min-h-10 items-center gap-2 px-2 py-1.5 text-xs text-[var(--dim)]">
                        <span className="font-console shrink-0 border border-white/15 px-1.5 py-0.5 text-[10px]">
                          地震
                        </span>
                        今日暂无 M6+ 地震
                      </p>
                    )}
                  </li>
                  {/* 活跃火山与活跃大火各一条（规格要求并列）；
                      两者都没有时才用风暴兜底一行。 */}
                  {(todayVolcano ? [todayVolcano] : todayStorm ? [todayStorm] : [])
                    .concat(todayFire ? [todayFire] : [])
                    .map((ev) => (
                      <li key={ev.id}>
                        <button
                          type="button"
                          aria-label={`查看自然事件：${ev.title}`}
                          onClick={() => goToEvent(ev)}
                          className="flex min-h-10 w-full items-center gap-2 border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors duration-200 hover:border-[var(--accent)]"
                        >
                          <span
                            aria-hidden="true"
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{
                              background:
                                EVENT_CAT_COLOR[ev.category] ?? "#ffffff",
                            }}
                          />
                          <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                            {EVENT_CAT_ZH[ev.category] ?? "事件"}
                          </span>
                          <span className="min-w-0 flex-1 text-sm leading-snug line-clamp-2">
                            {ev.title}
                          </span>
                        </button>
                      </li>
                    ))}
                  {ex?.ok && ex.hottest && CITY_BY_ID.get(ex.hottest.id) && (
                    <li>
                      <button
                        type="button"
                        aria-label={`查看今日极值冠军：${CITY_BY_ID.get(ex.hottest.id)!.zh}`}
                        onClick={() =>
                          goToCity(CITY_BY_ID.get(ex.hottest!.id)!)
                        }
                        className="flex min-h-10 w-full items-center gap-2 border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors duration-200 hover:border-[var(--accent)]"
                      >
                        <span className="font-console shrink-0 border border-[var(--gold)]/60 px-1.5 py-0.5 text-[10px] text-[var(--gold)]">
                          冠军
                        </span>
                        <span className="min-w-0 flex-1 text-sm leading-snug line-clamp-2">
                          此刻全球最热 · {CITY_BY_ID.get(ex.hottest.id)!.zh}{" "}
                          {ex.hottest.value.toFixed(1)}°C
                        </span>
                      </button>
                    </li>
                  )}
                </ul>
              )}
              {layers.radar && radarFrameTime && (
                <p className="font-console mt-3 text-[11px] text-[var(--dim)]">
                  雷达帧 {radarFrameTime}
                  {radarPlaying ? " · 播放中" : ""}（RainViewer 近 2 小时）
                </p>
              )}
            </div>
          </section>
        )}
        {fsMode && (
          <div className="absolute top-12 right-3 z-20 flex flex-col items-end gap-2 [right:max(0.75rem,env(safe-area-inset-right))] [top:max(3rem,calc(env(safe-area-inset-top)+2.25rem))]">
            <button
              type="button"
              aria-label="退出全屏"
              onClick={toggleFullscreen}
              className="font-console flex min-h-10 items-center border border-[var(--border)] bg-[#070c12]/90 px-3 py-2 text-xs text-[var(--text)] transition-colors duration-200"
            >
              退出全屏 ✕
            </button>
            {/* The 图层面板, fullscreen presentation: same panel,
                anchored to this stack. */}
            <LayerMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              layers={layers}
              onToggleLayer={toggleLayer}
              quakeCount={ee?.quakesOk ? ee.quakes.length : null}
              eventCount={ee?.eventsOk ? ee.events.length : null}
              auroraNote={auroraNote}
              flightCount={flightsQ.data?.ok ? flightsQ.data.count : null}
              flightSource={flightsQ.data?.ok ? flightsQ.data.source : null}
              shipCount={shipsQ.data?.ok ? shipsQ.data.count : null}
              shipSource={shipsQ.data?.ok ? shipsQ.data.source : null}
              webcamCount={webcamsQ.data?.ok ? webcamsQ.data.count : null}
              stationSource={stationsQ.data?.ok ? stationsQ.data.source : null}
              fsMode={fsMode}
              onFullscreen={toggleFullscreen}
              onLandscapeFs={enterLandscapeFs}
              spinOn={spinOn}
              onToggleSpin={() => setSpinOn((v) => !v)}
              todayOpen={todayOpen}
              onToggleToday={() => setTodayOpen((v) => !v)}
              timeOn={timeOn}
              onToggleTime={() => setTimeOn((v) => !v)}
              timeLabel={timeLabel}
              radarFrameCount={radarFrames.length}
              radarIdx={radarIdx}
              radarPlaying={radarPlaying}
              onToggleRadarPlay={() => setRadarPlaying((v) => !v)}
              radarStyle={radarStyle}
              onRadarStyle={pickRadarStyle}
              radarFrameTime={radarFrameTime}
              twilightOn={twilightOn}
              onToggleTwilight={() => setTwilightOn((v) => !v)}
              chaseOn={chaseOn}
              onToggleChase={() => {
                setChaseOn((v) => !v);
                if (!chaseOn) {
                  setTwilightOn(true);
                  goToSunset();
                }
              }}
              onGoSunset={goToSunset}
              twilightCount={twilightCitiesNow.length}
            />
          </div>
        )}
        {/* ── Bottom floating capsule (Google-Earth layout): the
            only bottom-edge element in framed mode — just the 自转
            toggle now, dark glass, lots of air around it (the
            Beijing clock and the 全屏 button that used to ride here
            were both removed at the user's word; fullscreen still
            lives in the 图层 panel's 显示 section). It steps aside
            whenever ANY bottom panel owns the edge: a detail card,
            the layers panel (a bottom sheet on phones), the
            长沙过境预报 panel (its third row used to slide under
            the capsule), and on phones the 地球此刻 panel. */}
        {!fsMode &&
          !menuOpen &&
          !(layers.stations && stationsQ.data?.ok) &&
          !selected &&
          !selQuake &&
          !selEvent &&
          !selFlight &&
          !selStation &&
          !selShip &&
          !selWebcam && (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4 [bottom:max(1.25rem,env(safe-area-inset-bottom))]">
              <div
                className={`pointer-events-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/55 px-1.5 py-1.5 shadow-lg backdrop-blur-md ${
                  todayOpen ? "max-sm:hidden" : ""
                }`}
              >
                <button
                  type="button"
                  aria-pressed={spinOn}
                  aria-label="地球自转开关"
                  onClick={() => setSpinOn((v) => !v)}
                  className={`font-console flex min-h-9 items-center rounded-full px-3 text-xs transition-colors duration-200 ${
                    spinOn ? "text-[var(--accent)]" : "text-white/80"
                  }`}
                >
                  自转 {spinOn ? "开" : "关"}
                </button>
              </div>
            </div>
          )}

        {/* Note toast (both modes): transient explanations —
            fullscreen fallback notes, sunset misses — float at the
            bottom centre, auto-dismissed by the note effect above.
            In framed mode it sits above the bottom capsule. */}
        {note && (
          <div
            className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${
              fsMode
                ? "bottom-5 [bottom:max(1.25rem,env(safe-area-inset-bottom))]"
                : "bottom-20"
            }`}
          >
            <p className="card-in rounded-full border border-[var(--accent)]/50 bg-black/70 px-4 py-2.5 text-center text-xs text-white shadow-lg backdrop-blur-md">
              {note}
            </p>
          </div>
        )}

        {/* ── Fullscreen compact panel (top-left, size-controlled) ── */}
        {selected && fsMode && (
          <article
            aria-label={`${selected.zh}实时天气（全屏紧凑面板）`}
            className="card-in absolute top-3 left-3 z-20 flex max-h-[64vh] w-[min(320px,88vw)] flex-col overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/97 shadow-2xl backdrop-blur-md [top:max(0.75rem,env(safe-area-inset-top))] [left:max(0.75rem,env(safe-area-inset-left))] landscape:w-[min(320px,46vw)]"
          >
            {/* City photo as the panel's full background (same design
                as the normal card): the data floats over it on a
                gradient veil + translucent cells, so the photo stays
                visible behind the whole panel instead of being walled
                into the 64px header strip. Loading discipline is the
                flight card's: solid face underneath, photo fades in
                only when its bytes arrive (CityPhotoBg). */}
            <CityPhotoBg
              key={selected.id}
              url={!imgBroken ? (photo.data?.url ?? null) : null}
              toneBg={toneBg}
              onError={() => setImgBroken(true)}
            />
            {fsCollapsed ? (
              <button
                type="button"
                aria-label={`展开${selected.zh}天气面板`}
                onClick={() => setFsCollapsed(false)}
                className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left"
              >
                <span className="truncate text-sm font-semibold">
                  {selected.zh}
                </span>
                <span className="text-lg leading-none font-semibold tabular-nums">
                  {w && w.ok ? `${fmtNum(w.temperature, 0)}°C` : "—"}
                </span>
                <span aria-hidden="true" className="text-xs">
                  {info.icon}
                </span>
                <span className="font-console ml-auto text-[11px] text-[var(--dim)]">
                  展开 ▾
                </span>
              </button>
            ) : (
              <>
                <div className="relative flex h-16 shrink-0 items-end overflow-hidden">
                  <div className="flex w-full items-end gap-1.5 px-3 pb-1.5">
                    <h2 className="min-w-0 flex-1 truncate text-base leading-tight font-semibold text-white">
                      {selected.zh}
                      <span className="font-console ml-1.5 text-[11px] font-normal text-white/70">
                        {selected.country} · {selected.region}
                      </span>
                    </h2>
                    <button
                      type="button"
                      aria-label="收起天气面板"
                      onClick={() => setFsCollapsed(true)}
                      className="font-console flex min-h-10 shrink-0 items-center border border-white/25 bg-black/30 px-2.5 py-0.5 text-[11px] text-white transition-colors duration-200"
                    >
                      收起 ▴
                    </button>
                    <button
                      type="button"
                      aria-label="关闭天气卡片"
                      onClick={clearSelection}
                      className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-0.5 text-[11px] text-white transition-colors duration-200"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div data-scroll-allow className="console-scroll relative min-h-0 overflow-y-auto px-3 py-2">
                  {weather.isPending && (
                    <WeatherSkeleton cityZh={selected.zh} compact />
                  )}
                  {(weather.isError || (w && !w.ok)) && (
                    <div className="py-4 text-center">
                      <p className="text-xs text-[var(--danger)]">
                        {w?.quotaExceeded
                          ? "数据暂不可用（天气服务今日调用额度已用完）"
                          : "数据暂不可用（天气服务暂时连不上）"}
                      </p>
                      <button
                        type="button"
                        aria-label="重新加载该城市天气"
                        onClick={() => weather.refetch()}
                        className="font-console mt-2 inline-flex min-h-10 items-center border border-white/25 bg-black/30 px-3 py-1.5 text-[11px] text-[var(--text)] transition-colors duration-200"
                      >
                        ⟳ 重新加载
                      </button>
                    </div>
                  )}
                  {w && w.ok && (
                    <>
                      <div className="flex items-center gap-3">
                        <span aria-hidden="true" className="text-3xl leading-none">
                          {info.icon}
                        </span>
                        <p className="text-4xl leading-none font-semibold tabular-nums">
                          {fmtNum(w.temperature, 0)}
                          <span className="text-xl align-top">°C</span>
                        </p>
                        <div className="min-w-0">
                          <p className="truncate text-sm">{info.label}</p>
                          {w.pm25 != null ? (
                            <p className="mt-0.5 flex items-center gap-1.5 text-xs">
                              <span
                                className="font-console px-1 py-px text-[10px] font-bold"
                                style={{
                                  background: pmLevel(w.pm25).color,
                                  color: "#0a1017",
                                }}
                              >
                                {pmLevel(w.pm25).text}
                              </span>
                              <span className="tabular-nums">
                                PM2.5 {fmtNum(w.pm25)}
                              </span>
                            </p>
                          ) : (
                            <p className="mt-0.5 text-xs text-[var(--dim)]">
                              无空气质量数据
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="font-console mt-2 flex items-center gap-x-3 text-[11px] text-[var(--dim)] tabular-nums">
                        <span>
                          当地{" "}
                          <span className="text-sm text-[var(--text)]">
                            {fmtClock(localTz, nowTick, false)}
                          </span>
                        </span>
                        <span>
                          北京{" "}
                          <span className="text-sm text-[var(--text)]">
                            {fmtClock("Asia/Shanghai", nowTick, false)}
                          </span>
                        </span>
                      </div>

                      {twilightLine && (
                        <p className="mt-2 flex items-center gap-1.5 border border-[#ff8a3a]/50 bg-[rgba(43,20,2,0.45)] px-2 py-1.5 text-xs text-[#ffcf9e]">
                          <SunsetIcon className="h-3.5 w-3.5" />
                          <span>
                            {twilightLine}
                            {w.sunset ? ` · 日落 ${w.sunset}` : ""}
                          </span>
                        </p>
                      )}

                      {fsExpanded && (
                        <>
                          <dl className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                            {(
                              [
                                ["体感", w.apparentTemperature != null ? `${fmtNum(w.apparentTemperature)}°C` : "—"],
                                ["湿度", w.humidity != null ? `${fmtNum(w.humidity)}%` : "—"],
                                ["风速", w.windSpeed != null ? `${fmtNum(w.windSpeed)} km/h` : "—"],
                                ["气压", w.pressure != null ? `${fmtNum(w.pressure)} hPa` : "—"],
                                ["日出", w.sunrise ?? "—"],
                                ["日落", w.sunset ?? "—"],
                              ] as Array<[string, string]>
                            ).map(([k, v]) => (
                              <div
                                key={k}
                                className="border border-white/15 bg-black/35 px-1.5 py-1.5"
                              >
                                <dt className="font-console text-[10px] tracking-[0.12em] text-[var(--dim)]">
                                  {k}
                                </dt>
                                <dd className="mt-0.5 text-xs font-medium tabular-nums">
                                  {v}
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <p className="font-console mt-2 flex flex-wrap items-center gap-x-2 text-[10px] text-[var(--dim)]">
                            <span>
                              Open-Meteo
                              {w.fetchedAt
                                ? ` · 更新于 ${new Date(w.fetchedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })}（北京）`
                                : ""}
                            </span>
                            <button
                              type="button"
                              aria-label="刷新该城市天气"
                              onClick={() => weather.refetch()}
                              className="inline-flex min-h-10 items-center border border-[var(--border)] px-2.5 py-0.5 text-[var(--text)] transition-colors duration-200"
                            >
                              刷新
                            </button>
                            {photo.data?.pageUrl && (
                              <a
                                href={photo.data.pageUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="查看该城市的维基百科条目"
                                className="text-[var(--accent)]"
                              >
                                城市百科 ↗
                              </a>
                            )}
                          </p>
                          {/* Street view lives in the expanded detail
                              only, so the compact panel stays one
                              glance (per the user's spec). */}
                          <StreetViewBlock
                            key={selected.id}
                            street={streetView}
                            placeZh={selected.zh}
                            onReload={() => void streetView.refetch()}
                          />
                        </>
                      )}

                      <button
                        type="button"
                        aria-label={fsExpanded ? "收起详情" : "展开详情"}
                        aria-expanded={fsExpanded}
                        onClick={() => setFsExpanded((v) => !v)}
                        className="font-console mt-2 flex min-h-10 w-full items-center justify-center border border-[var(--border)] py-1.5 text-[11px] text-[var(--text)] transition-colors duration-200"
                      >
                        {fsExpanded ? "收起详情 ▴" : "展开详情 ▾"}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </article>
        )}

        {/* ── Weather card (normal mode) ─────────────────────────── */}
        {selected && !fsMode && (
          <article
            aria-label={`${selected.zh}实时天气`}
            className="card-in absolute right-3 bottom-3 left-3 z-20 flex max-h-[68%] flex-col overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/97 shadow-2xl backdrop-blur-md lg:top-1/2 lg:right-4 lg:bottom-auto lg:left-auto lg:max-h-[92%] lg:w-[392px] lg:-translate-y-1/2"
          >
            {/* City photo as the card's FULL background (the user's
                ask): the representative photo underlays the entire
                card, and the information layer floats over it — a
                top-to-bottom gradient veil plus translucent-black
                stat cells — so the table never walls the photo off,
                yet every number keeps a dark backing and stays
                readable. No photo → the weather-toned gradient is
                the background instead. Loading discipline is the
                flight card's: the article's own solid face
                (bg-[#070c12]/97) is what the text sits on while
                anything loads, and the photo fades in only once its
                bytes arrive (CityPhotoBg) — never a translucent
                card with text over the bare globe / a half-loaded
                bright photo. */}
            <CityPhotoBg
              key={selected.id}
              url={!imgBroken ? (photo.data?.url ?? null) : null}
              toneBg={toneBg}
              onError={() => setImgBroken(true)}
            />
            {/* Header over the photo background */}
            <div className="relative flex shrink-0 items-end gap-2 px-4 pt-4 pb-1">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xl leading-tight font-semibold text-white">
                    {selected.zh}
                    <span className="font-console ml-2 text-sm font-normal text-white/75">
                      {selected.en}
                    </span>
                  </h2>
                  <p className="font-console mt-0.5 text-[11px] tracking-[0.08em] text-white/70">
                    {selected.country} · {selected.region}
                    {selected.capital ? " · 首都" : ""} ·{" "}
                    {Math.abs(selected.lat).toFixed(2)}°
                    {selected.lat >= 0 ? "N" : "S"} /{" "}
                    {Math.abs(selected.lng).toFixed(2)}°
                    {selected.lng >= 0 ? "E" : "W"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭天气卡片"
                  onClick={clearSelection}
                  className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
                >
                  ✕
                </button>
              </div>
            {photo.data?.url && !imgBroken && (
              <p className="font-console relative shrink-0 px-4 pt-1 text-[10px] text-white/65">
                照片：维基百科 / Wikimedia（本地缓存）
              </p>
            )}

            <div data-scroll-allow className="console-scroll relative min-h-0 overflow-y-auto px-4 py-3">
              {weather.isPending && <WeatherSkeleton cityZh={selected.zh} />}
              {(weather.isError || (w && !w.ok)) && (
                <div className="py-8 text-center">
                  <p className="text-sm text-[var(--danger)]">
                    {w?.quotaExceeded
                      ? "数据暂不可用（天气服务今日调用额度已用完）"
                      : "数据暂不可用（天气服务暂时连不上）"}
                  </p>
                  <button
                    type="button"
                    aria-label="重新加载该城市天气"
                    onClick={() => weather.refetch()}
                    className="font-console mt-3 inline-flex min-h-10 items-center border border-white/25 bg-black/30 px-3 py-2 text-xs text-[var(--text)] transition-colors duration-200"
                  >
                    ⟳ 重新加载
                  </button>
                </div>
              )}
              {w && w.ok && (
                <>
                  {/* Temperature + condition */}
                  <div className="flex items-center gap-4">
                    <span aria-hidden="true" className="text-5xl leading-none">
                      {info.icon}
                    </span>
                    <div>
                      <p className="text-5xl leading-none font-semibold tabular-nums">
                        {fmtNum(w.temperature, 0)}
                        <span className="text-2xl align-top">°C</span>
                      </p>
                      <p className="mt-1 text-sm text-[var(--dim)]">
                        {info.label} · 体感 {fmtNum(w.apparentTemperature, 0)}°C
                      </p>
                    </div>
                    <div className="font-console ml-auto text-right text-[11px] leading-relaxed text-[var(--dim)]">
                      <p>日出 {w.sunrise ?? "—"}</p>
                      <p>日落 {w.sunset ?? "—"}</p>
                      <p className="text-white/50">（当地时间）</p>
                    </div>
                  </div>

                  {/* Stat grid */}
                  <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                    {(
                      [
                        ["湿度", w.humidity != null ? `${fmtNum(w.humidity)}%` : "—"],
                        ["风速", w.windSpeed != null ? `${fmtNum(w.windSpeed)} km/h` : "—"],
                        ["气压", w.pressure != null ? `${fmtNum(w.pressure)} hPa` : "—"],
                        ["降水", w.precipitation != null ? `${fmtNum(w.precipitation, 1)} mm` : "—"],
                      ] as Array<[string, string]>
                    ).map(([k, v]) => (
                      <div key={k} className="border border-white/15 bg-black/35 px-1 py-2">
                        <dt className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">{k}</dt>
                        <dd className="mt-0.5 text-[13px] font-medium tabular-nums">{v}</dd>
                      </div>
                    ))}
                  </dl>

                  {/* Twilight status (追霞): sunset time + live
                      countdown while this place is in / near dusk. */}
                  {twilightLine && (
                    <p className="mt-2 flex items-center gap-1.5 border border-[#ff8a3a]/50 bg-[rgba(43,20,2,0.45)] px-3 py-2 text-sm text-[#ffcf9e]">
                      <SunsetIcon />
                      <span>
                        {twilightLine}
                        {w.sunset ? ` · 日落 ${w.sunset}（当地）` : ""}
                      </span>
                    </p>
                  )}

                  {/* Air quality */}
                  <div className="mt-2 border border-white/15 bg-black/35 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
                        空气质量
                      </span>
                      {w.pm25 != null ? (
                        <>
                          <span
                            className="font-console px-1.5 py-0.5 text-[11px] font-bold"
                            style={{ background: pmLevel(w.pm25).color, color: "#0a1017" }}
                          >
                            {pmLevel(w.pm25).text}
                          </span>
                          <span className="text-sm tabular-nums">
                            PM2.5 {fmtNum(w.pm25)} µg/m³
                          </span>
                          <span className="font-console text-[11px] text-[var(--dim)] tabular-nums">
                            PM10 {fmtNum(w.pm10)} · 美标 AQI {fmtNum(w.usAqi)}（参考）
                          </span>
                        </>
                      ) : (
                        <span className="text-sm text-[var(--dim)]">该地区暂无空气质量数据</span>
                      )}
                    </div>
                  </div>

                  {/* Aurora probability (v3.0): only while the
                      aurora layer's NOAA data is loaded — read from
                      the same OVATION grid the globe renders. */}
                  {selAuroraProb != null && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#64e696]/40 bg-[rgba(6,32,20,0.45)] px-3 py-2.5">
                      <span className="font-console text-[10px] tracking-[0.14em] text-[#7dffb0]">
                        极光可见概率
                      </span>
                      <span className="text-sm font-semibold tabular-nums">
                        {selAuroraProb}%
                      </span>
                      <span className="font-console text-[11px] text-[var(--dim)]">
                        NOAA OVATION 预报
                        {auroraQ.data?.forecastTime
                          ? ` · ${fmtBjTime(auroraQ.data.forecastTime)}（北京）`
                          : ""}
                        {selAuroraProb === 0 ? " · 该地不在预报网格的极光带内" : ""}
                      </span>
                    </div>
                  )}

                  {/* Dual clocks */}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="border border-[var(--accent)]/40 bg-[rgba(7,26,36,0.5)] px-3 py-2.5">
                      <p className="font-console text-[10px] tracking-[0.14em] text-[var(--accent)]">
                        当地时间 · {localTz === "auto" ? "按坐标解析" : localTz}
                      </p>
                      <p className="font-console mt-0.5 text-xl font-semibold tabular-nums">
                        {fmtClock(localTz, nowTick, true)}
                      </p>
                    </div>
                    <div className="border border-white/15 bg-black/35 px-3 py-2.5">
                      <p className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
                        北京时间 · Asia/Shanghai
                      </p>
                      <p className="font-console mt-0.5 text-xl font-semibold tabular-nums">
                        {fmtClock("Asia/Shanghai", nowTick, true)}
                      </p>
                    </div>
                  </div>

                  <p className="font-console mt-3 flex flex-wrap items-center gap-x-3 text-[11px] text-[var(--dim)]">
                    <span>
                      数据来源 Open-Meteo
                      {w.fetchedAt
                        ? ` · 更新于 ${new Date(w.fetchedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })}（北京）`
                        : ""}
                    </span>
                    <button
                      type="button"
                      aria-label="刷新该城市天气"
                      onClick={() => weather.refetch()}
                      className="inline-flex min-h-10 items-center border border-[var(--border)] px-2.5 py-0.5 text-[var(--text)] transition-colors duration-200"
                    >
                      刷新
                    </button>
                    {photo.data?.pageUrl && (
                      <a
                        href={photo.data.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="查看该城市的维基百科条目"
                        className="text-[var(--accent)]"
                      >
                        城市百科 ↗
                      </a>
                    )}
                  </p>
                </>
              )}
              {/* Street-level photo (Mapillary): independent of the
                  weather state above — renders in the same scroll
                  region, below the weather grid. */}
              <StreetViewBlock
                key={selected.id}
                street={streetView}
                placeZh={selected.zh}
                onReload={() => void streetView.refetch()}
              />
            </div>
          </article>
        )}

        {/* ── Earthquake detail card (v2.0) ──────────────────────── */}
        {selQuake && (
          <article
            aria-label={`地震详情：${selQuake.place}`}
            className="card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]"
          >
            <div className="flex items-start gap-3 px-4 py-3">
              <p
                className="font-console shrink-0 px-2 py-1 text-lg font-bold"
                style={{
                  background:
                    selQuake.mag >= 7
                      ? "#ff3b30"
                      : selQuake.mag >= 6
                        ? "#ff7b54"
                        : selQuake.mag >= 5.5
                          ? "#ffa53a"
                          : "#ffd166",
                  color: "#140b02",
                }}
              >
                M{selQuake.mag.toFixed(1)}
              </p>
              <div className="min-w-0 flex-1">
                <h2 className="text-base leading-snug font-semibold">
                  {selQuake.place || "未知地点"}
                </h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {Math.abs(selQuake.lat).toFixed(2)}°
                  {selQuake.lat >= 0 ? "N" : "S"} /{" "}
                  {Math.abs(selQuake.lng).toFixed(2)}°
                  {selQuake.lng >= 0 ? "E" : "W"}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭地震详情"
                onClick={() => setSelQuake(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <dl className="grid grid-cols-3 gap-2 px-4 pb-3 text-center">
              {(
                [
                  ["震级", `M${selQuake.mag.toFixed(1)}`],
                  [
                    "深度",
                    selQuake.depth != null
                      ? `${selQuake.depth.toFixed(0)} km`
                      : "—",
                  ],
                  [
                    "发生时间（北京）",
                    new Date(selQuake.time).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }),
                  ],
                ] as Array<[string, string]>
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="border border-white/15 bg-black/35 px-2 py-2"
                >
                  <dt className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">
                    {k}
                  </dt>
                  <dd className="mt-0.5 text-sm font-medium tabular-nums">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="font-console flex flex-wrap items-center gap-x-3 px-4 pb-3 text-[11px] text-[var(--dim)]">
              <span>数据来源 USGS（过去 24 小时 M4.5+）</span>
              {selQuake.url && (
                <a
                  href={selQuake.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="在 USGS 查看这次地震的详情"
                  className="text-[var(--accent)]"
                >
                  USGS 详情 ↗
                </a>
              )}
              <button
                type="button"
                aria-label="查看震中附近天气"
                onClick={() => goToPoint(selQuake.lat, selQuake.lng)}
                className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] transition-colors duration-200"
              >
                看震中天气
              </button>
            </p>
          </article>
        )}

        {/* ── Natural-event detail card (v2.0) ───────────────────── */}
        {selEvent && (
          <article
            aria-label={`自然事件详情：${selEvent.title}`}
            className="card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]"
          >
            <div className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-[#0a141f]"
                style={{
                  borderColor: EVENT_CAT_COLOR[selEvent.category] ?? "#ffffff",
                }}
              >
                <span
                  className="h-3 w-3 rounded-full"
                  style={{
                    background: EVENT_CAT_COLOR[selEvent.category] ?? "#ffffff",
                  }}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-console text-[11px] tracking-[0.14em] text-[var(--accent)]">
                  {EVENT_CAT_ZH[selEvent.category] ?? "自然事件"}
                </p>
                <h2 className="mt-0.5 text-base leading-snug font-semibold">
                  {selEvent.title || "未命名事件"}
                </h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {Math.abs(selEvent.lat).toFixed(2)}°
                  {selEvent.lat >= 0 ? "N" : "S"} /{" "}
                  {Math.abs(selEvent.lng).toFixed(2)}°
                  {selEvent.lng >= 0 ? "E" : "W"}
                  {selEvent.date
                    ? ` · 开始（北京） ${new Date(selEvent.date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭事件详情"
                onClick={() => setSelEvent(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <p className="font-console flex flex-wrap items-center gap-x-3 px-4 pb-3 text-[11px] text-[var(--dim)]">
              <span>数据来源 NASA EONET（开放事件）</span>
              {(selEvent.sourceUrl ?? selEvent.link) && (
                <a
                  href={(selEvent.sourceUrl ?? selEvent.link)!}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="打开事件来源链接"
                  className="text-[var(--accent)]"
                >
                  来源链接 ↗
                </a>
              )}
              <button
                type="button"
                aria-label="查看事件所在地天气"
                onClick={() => goToPoint(selEvent.lat, selEvent.lng)}
                className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] transition-colors duration-200"
              >
                看当地天气
              </button>
            </p>
          </article>
        )}

        {/* ── Flight detail card (v3.0) ──────────────────────────── */}
        {selFlight && (
          <article
            aria-label={`航班详情：${selFlight.callsign ?? selFlight.id}`}
            className={`card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]${
              flightClean ? " min-h-[264px]" : ""
            }`}
          >
            {/* Aircraft photo as the card's background (same design
                as the city weather card): resolved server-side for
                this one aircraft — its own full-size photo via
                adsbdb/airport-data or its latest Planespotters
                photo, else a same-type photo from Wikimedia
                Commons — and faded in when it arrives. No photo →
                the plain card face above stays. In 清屏 mode the
                text blocks below are display-hidden (never
                unmounted) and the photo (or the plain face, when
                there is none) fills the card; the ONLY way back is
                the standalone 「恢复信息」 button below — the card
                itself carries no tap handlers at all (see the
                clean-state comment where cleanFlightId is declared
                for why the tap-anywhere + click-swallow mechanisms
                were deleted). The photo layer is
                pointer-events-none, so it can never cover the
                button. */}
            {flightPhoto.data?.url && (
              <FlightPhotoBg
                key={selFlight.id}
                url={flightPhoto.data.url}
                clean={flightClean}
              />
            )}
            {flightClean && (
              <button
                type="button"
                aria-label="恢复显示航班信息"
                onClick={() => setCleanFlightId(null)}
                className="font-console pointer-events-auto absolute right-3 bottom-3 z-30 flex min-h-11 items-center border border-white/40 bg-black/75 px-4 py-2 text-xs text-white shadow-lg backdrop-blur-sm transition-colors duration-200"
              >
                恢复信息
              </button>
            )}
            <div className={flightClean ? "hidden" : "contents"}>
            <div className="relative flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-[#0a141f]"
                style={{
                  borderColor:
                    selFlight.kind === "heli"
                      ? "rgba(115,242,140,0.7)"
                      : selFlight.kind === "prop"
                        ? "rgba(255,138,107,0.75)"
                        : selFlight.kind === "bizjet"
                          ? "rgba(201,167,255,0.7)"
                          : "rgba(165,243,252,0.7)",
                  color:
                    selFlight.kind === "heli"
                      ? "#73f28c"
                      : selFlight.kind === "prop"
                        ? "#ff8a6b"
                        : selFlight.kind === "bizjet"
                          ? "#c9a7ff"
                          : "#c7f0ff",
                }}
              >
                <FlightKindIcon kind={selFlight.kind} className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-console text-base leading-snug font-semibold">
                  {selFlight.callsign ?? "无呼号"}
                  {selFlight.detail ? (
                    <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                      {selFlight.detail}
                    </span>
                  ) : null}
                </h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {FLIGHT_KIND_ZH[selFlight.kind]} ·{" "}
                  {Math.abs(selFlight.lat).toFixed(2)}°
                  {selFlight.lat >= 0 ? "N" : "S"} /{" "}
                  {Math.abs(selFlight.lng).toFixed(2)}°
                  {selFlight.lng >= 0 ? "E" : "W"}
                  {flightsQ.data?.fetchedAt
                    ? ` · 位置更新 ${fmtBjTime(flightsQ.data.fetchedAt)}（北京）`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label="清屏：隐藏卡片文字，只看飞机照片"
                onClick={() => setCleanFlightId(selFlight.id)}
                className="font-console flex min-h-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2.5 py-1 text-xs whitespace-nowrap text-white transition-colors duration-200"
              >
                清屏
              </button>
              <button
                type="button"
                aria-label="关闭航班详情"
                onClick={() => setSelFlight(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            {flightPhoto.data?.url && (
              <p className="font-console relative px-4 pb-1 text-[10px] text-white/65">
                {flightPhoto.data.match === "type" ? "同机型照片" : "本机照片"}
                {flightPhoto.data.credit
                  ? ` · ${flightPhoto.data.credit}`
                  : ""}{" "}
                ·{" "}
                {flightPhoto.data.pageUrl ? (
                  <a
                    href={flightPhoto.data.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="在照片来源页查看原图"
                    className="underline decoration-white/40 underline-offset-2"
                  >
                    {flightPhoto.data.source === "commons"
                      ? "Wikimedia Commons"
                      : "Planespotters"}
                  </a>
                ) : flightPhoto.data.source === "airport-data" ? (
                  "airport-data.com"
                ) : flightPhoto.data.source === "commons" ? (
                  "Wikimedia Commons"
                ) : (
                  "Planespotters"
                )}
              </p>
            )}
            {/* Two rows of three (edit #37 — the user asked to
                replace 始发地/目的地 with other real interface
                data): row 1 is live flight data from the feed
                （高度/地速/航向）; row 2 mixes the feed's live 爬升率
                with the aircraft archive （国籍 from the registration
                prefix, refined by adsbdb's registry country; 运营方
                = adsbdb's registered owner/operator). Every cell
                falls back to 未知/— when its source has nothing —
                values are never invented, and no 机龄 cell exists:
                no reachable interface carries a manufacture year. */}
            <dl className="relative grid grid-cols-3 gap-2 px-4 pb-3 text-center">
              {(
                [
                  ["高度", selFlight.altM != null ? `${selFlight.altM.toLocaleString()} m` : "—"],
                  ["地速", selFlight.speedKmh != null ? `${selFlight.speedKmh} km/h` : "—"],
                  ["航向", selFlight.heading != null ? `${selFlight.heading}° ${azZh(selFlight.heading)}` : "—"],
                  [
                    "国籍",
                    flightCountry(
                      selFlight.reg,
                      flightAircraft.data?.found
                        ? flightAircraft.data
                        : null,
                    ),
                  ],
                  [
                    "运营方",
                    flightAircraft.isPending
                      ? "查询中…"
                      : (flightAircraft.data?.owner ?? "未知"),
                    flightAircraft.data?.owner ?? undefined,
                  ],
                  ["爬升率", vrateText(selFlight.vrateMs)],
                ] as Array<[string, string, (string | undefined)?]>
              ).map(([k, v, title]) => (
                <div key={k} className="min-w-0 border border-white/15 bg-black/35 px-2 py-2">
                  <dt className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">{k}</dt>
                  <dd
                    title={title}
                    className="mt-0.5 truncate text-sm font-medium tabular-nums"
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="font-console relative flex flex-wrap items-center gap-x-3 px-4 pb-3 text-[11px] text-[var(--dim)]">
              <span>
                实时 ADS-B 位置
                {flightsQ.data?.source === "adsb.lol"
                  ? " · 来源 adsb.lol（OpenSky 从服务器网络不可达，备源）"
                  : flightsQ.data?.source
                    ? ` · 来源 ${flightsQ.data.source}`
                    : ""}
                {" "}· 机身档案（运营方/注册国）由 adsbdb 按应答机编号查询，查不到标「未知」
              </span>
              <button
                type="button"
                aria-label="查看航班下方地面天气"
                onClick={() => goToPoint(selFlight.lat, selFlight.lng)}
                className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] transition-colors duration-200"
              >
                看下方天气
              </button>
            </p>
            </div>
          </article>
        )}

        {/* ── Ship detail card (AIS 船舶层） ─────────────────────── */}
        {selShip && (
          <article
            aria-label={`船舶详情：${selShip.name ?? selShip.id}`}
            className={`card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]${
              shipClean ? " min-h-[264px]" : ""
            }`}
          >
            {/* Vessel photo as the card's background (same design as
                the flight card): resolved server-side for this one
                ship only — a Commons photo whose file title names
                the vessel, else a same-class photo — and faded in
                when it arrives. No photo → the plain card face
                stays. In 清屏 mode the text blocks are
                display-hidden (never unmounted, same as the flight
                card) and the photo fills the card; the ONLY way back
                is the standalone 「恢复信息」 button below — the
                same no-timing mechanism as the flight card (the
                card carries no tap handlers, no click swallow). */}
            {shipPhoto.data?.url && (
              <FlightPhotoBg
                key={selShip.id}
                url={shipPhoto.data.url}
                clean={shipClean}
              />
            )}
            {shipClean && (
              <button
                type="button"
                aria-label="恢复显示船舶信息"
                onClick={() => setCleanShipId(null)}
                className="font-console pointer-events-auto absolute right-3 bottom-3 z-30 flex min-h-11 items-center border border-white/40 bg-black/75 px-4 py-2 text-xs text-white shadow-lg backdrop-blur-sm transition-colors duration-200"
              >
                恢复信息
              </button>
            )}
            <div className={shipClean ? "hidden" : "contents"}>
            <div className="relative flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-[#0a141f]"
                style={{
                  borderColor: `${SHIP_KIND_COLOR[selShip.kind]}b3`,
                  color: SHIP_KIND_COLOR[selShip.kind],
                }}
              >
                <ShipKindIcon kind={selShip.kind} className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-console text-base leading-snug font-semibold">
                  {selShip.name ?? "未知船名"}
                  <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                    {SHIP_KIND_ZH[selShip.kind]}
                  </span>
                </h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {Math.abs(selShip.lat).toFixed(2)}°
                  {selShip.lat >= 0 ? "N" : "S"} /{" "}
                  {Math.abs(selShip.lng).toFixed(2)}°
                  {selShip.lng >= 0 ? "E" : "W"}
                  {selShip.reportedAt != null
                    ? ` · 位置更新 ${fmtBjTime(selShip.reportedAt)}（北京）`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label="清屏：隐藏卡片文字，只看船舶照片"
                onClick={() => setCleanShipId(selShip.id)}
                className="font-console flex min-h-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2.5 py-1 text-xs whitespace-nowrap text-white transition-colors duration-200"
              >
                清屏
              </button>
              <button
                type="button"
                aria-label="关闭船舶详情"
                onClick={() => setSelShip(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            {shipPhoto.data?.url && (
              <p className="font-console relative px-4 pb-1 text-[10px] text-white/65">
                {shipPhoto.data.match === "type" ? "同船型照片" : "本船照片（按船名匹配）"}
                {shipPhoto.data.credit
                  ? ` · ${shipPhoto.data.credit}`
                  : ""}{" "}
                ·{" "}
                {shipPhoto.data.pageUrl ? (
                  <a
                    href={shipPhoto.data.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="在照片来源页查看原图"
                    className="underline decoration-white/40 underline-offset-2"
                  >
                    Wikimedia Commons
                  </a>
                ) : (
                  "Wikimedia Commons"
                )}
              </p>
            )}
            {/* Every value is the AIS report itself: 航速 in knots
                as broadcast; 航向 prefers COG, falling back to the
                compass heading; 目的地 and ETA are crew-entered free
                text (labelled 船员自报， empty → 未申报）; 船长 is
                bow+stern metres from the static report. Nothing is
                invented — missing fields show —. */}
            <dl className="relative grid grid-cols-3 gap-2 px-4 pb-3 text-center">
              {(
                [
                  ["航速", selShip.sogKn != null ? `${selShip.sogKn.toFixed(1)} 节` : "—"],
                  [
                    "航向",
                    selShip.cog != null
                      ? `${Math.round(selShip.cog)}° ${azZh(selShip.cog)}`
                      : selShip.heading != null
                        ? `${selShip.heading}° ${azZh(selShip.heading)}`
                        : "—",
                  ],
                  ["吃水", selShip.draughtM != null ? `${selShip.draughtM.toFixed(1)} m` : "—"],
                  ["目的地", selShip.dest ?? "未申报", selShip.dest ?? undefined],
                  [
                    "船长",
                    selShip.lenM != null ? `${Math.round(selShip.lenM)} m` : "—",
                  ],
                  ["状态", navStatText(selShip.navStat)],
                ] as Array<[string, string, (string | undefined)?]>
              ).map(([k, v, title]) => (
                <div key={k} className="min-w-0 border border-white/15 bg-black/35 px-2 py-2">
                  <dt className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">{k}</dt>
                  <dd
                    title={title}
                    className="mt-0.5 truncate text-sm font-medium tabular-nums"
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="font-console relative flex flex-wrap items-center gap-x-3 px-4 pb-3 text-[11px] text-[var(--dim)]">
              <span>
                MMSI {selShip.id}
                {selShip.imo != null ? ` · IMO ${selShip.imo}` : ""}
                {selShip.callsign ? ` · 呼号 ${selShip.callsign}` : ""}
                {selShip.beamM != null ? ` · 船宽 ${Math.round(selShip.beamM)} m` : ""}
                {selShip.etaText ? ` · 预计抵达 ${selShip.etaText}（船员自报）` : ""}
                {" "}· AIS 实时位置
                {shipsQ.data?.source === "aisstream.io"
                  ? " · 来源 aisstream.io（全球 AIS 流）"
                  : shipsQ.data?.source === "digitraffic"
                    ? " · 来源 Digitraffic（芬兰交通基础设施局，波罗的海海域）"
                    : shipsQ.data?.source
                      ? ` · 来源 ${shipsQ.data.source}（免 key AIS 接口）`
                      : ""}
              </span>
              <button
                type="button"
                aria-label="查看船舶下方海面天气"
                onClick={() => goToPoint(selShip.lat, selShip.lng)}
                className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] transition-colors duration-200"
              >
                看下方天气
              </button>
            </p>
            </div>
          </article>
        )}

        {/* ── Webcam detail card (Windy 摄像头层） ───────────────── */}
        {selWebcam && (
          <article
            aria-label={`摄像头详情：${selWebcam.title}`}
            className="card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]"
          >
            <div className="relative flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-amber-300/70 bg-[#0a141f] text-amber-200"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-6 w-6"
                >
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base leading-snug font-semibold">
                  {webcamDetail.data?.title ?? selWebcam.title}
                </h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {[webcamDetail.data?.city ?? selWebcam.city,
                    webcamDetail.data?.region,
                    webcamDetail.data?.country ?? selWebcam.country]
                    .filter(Boolean)
                    .join(" · ")}
                  {` · ${Math.abs(selWebcam.lat).toFixed(2)}°${selWebcam.lat >= 0 ? "N" : "S"} / ${Math.abs(selWebcam.lng).toFixed(2)}°${selWebcam.lng >= 0 ? "E" : "W"}`}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭摄像头详情"
                onClick={() => setSelWebcam(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            {/* The live frame: fetched fresh by the server for this
                one webcam at tap time (free-plan image links live
                ~15 minutes). While it loads — or if Windy has no
                current frame — the slot keeps a labelled placeholder
                instead of a broken image. */}
            <div className="relative px-4">
              {webcamDetail.data?.ok && webcamDetail.data.imageUrl ? (
                <img
                  src={webcamDetail.data.imageUrl}
                  alt={`${selWebcam.title} 的实时画面`}
                  className="aspect-video w-full border border-white/10 object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="font-console flex aspect-video w-full items-center justify-center border border-white/10 bg-black/40 px-4 text-center text-xs text-[var(--dim)]">
                  {webcamDetail.isPending
                    ? "正在取实时画面…"
                    : "暂时取不到实时画面（摄像头可能离线或 Windy 暂不可达）"}
                </div>
              )}
            </div>
            {webcamDetail.data?.categories &&
              webcamDetail.data.categories.length > 0 && (
                <p className="font-console relative flex flex-wrap gap-1.5 px-4 pt-2">
                  {webcamDetail.data.categories.map((c) => (
                    <span
                      key={c}
                      className="border border-white/15 bg-black/35 px-1.5 py-0.5 text-[10px] text-white/75"
                    >
                      {c}
                    </span>
                  ))}
                </p>
              )}
            <p className="font-console relative flex flex-wrap items-center gap-x-3 px-4 py-3 text-[11px] text-[var(--dim)]">
              <span>
                来源 Windy Webcams
                {webcamDetail.data?.updatedAt
                  ? ` · 画面更新 ${fmtBjTime(webcamDetail.data.updatedAt)}（北京）`
                  : ""}
              </span>
              {webcamDetail.data?.detailUrl && (
                <a
                  href={webcamDetail.data.detailUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="在 Windy 打开该摄像头页面"
                  className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] underline-offset-2 transition-colors duration-200"
                >
                  在 Windy 看大图
                </a>
              )}
              <button
                type="button"
                aria-label="查看摄像头下方天气"
                onClick={() => goToPoint(selWebcam.lat, selWebcam.lng)}
                className="inline-flex min-h-9 items-center border border-[var(--border)] px-2 py-0.5 text-[var(--text)] transition-colors duration-200"
              >
                看下方天气
              </button>
            </p>
          </article>
        )}

        {/* ── Station detail card (v3.0) ─────────────────────────── */}
        {selStation && (
          <article
            aria-label={`空间站详情：${selStation.name}`}
            className="card-in absolute right-3 bottom-3 left-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-[#070c12]/94 shadow-2xl backdrop-blur-md lg:right-4 lg:left-auto lg:w-[392px]"
          >
            <div className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-[#0a141f]"
                style={{ borderColor: selStation.id === "css" ? "#fda4af" : "#7dd3fc" }}
              >
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ background: selStation.id === "css" ? "#fda4af" : "#7dd3fc" }}
                />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base leading-snug font-semibold">{selStation.name}</h2>
                <p className="font-console mt-0.5 text-[11px] text-[var(--dim)]">
                  {Math.abs(selStation.lat).toFixed(2)}°
                  {selStation.lat >= 0 ? "N" : "S"} /{" "}
                  {Math.abs(selStation.lng).toFixed(2)}°
                  {selStation.lng >= 0 ? "E" : "W"}
                  {stationsQ.data?.fetchedAt
                    ? ` · ${fmtBjTime(stationsQ.data.fetchedAt)}（北京）传播`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭空间站详情"
                onClick={() => setSelStation(null)}
                className="font-console flex min-h-10 min-w-10 shrink-0 items-center justify-center border border-white/25 bg-black/30 px-2 py-1 text-xs text-white transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <dl className="grid grid-cols-3 gap-2 px-4 pb-3 text-center">
              {(
                [
                  ["轨道高度", `${selStation.altKm} km`],
                  ["速度", `${selStation.velocityKmh.toLocaleString()} km/h`],
                  [
                    "下次长沙过境",
                    selStationPass ? fmtBj(selStationPass.peak) : "72h 内无",
                  ],
                ] as Array<[string, string]>
              ).map(([k, v]) => (
                <div key={k} className="border border-white/15 bg-black/35 px-2 py-2">
                  <dt className="font-console text-[10px] tracking-[0.14em] text-[var(--dim)]">{k}</dt>
                  <dd className="mt-0.5 text-sm font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {selStationPass && (
              <p className="px-4 pb-3 text-xs leading-relaxed text-[var(--dim)]">
                长沙过境：{fmtBj(selStationPass.start)} 自{azZh(selStationPass.riseAz)}方升起，
                {fmtBjTime(selStationPass.peak)} 最高 {selStationPass.maxEl}°，
                {fmtBjTime(selStationPass.end)} 落向{azZh(selStationPass.setAz)}方
                {selStationPass.visible ? " · 天黑且站体被照亮，肉眼可见" : " · 本次不可见（白天或站体在地影中）"}
              </p>
            )}
            <p className="font-console px-4 pb-3 text-[11px] text-[var(--dim)]">
              数据来源{" "}
              {stationsQ.data?.source === "amsat"
                ? "AMSAT 镜像 TLE（CelesTrak 备源）"
                : "CelesTrak TLE"}{" "}
              · SGP4 实时传播（约每 90 分钟绕地球一圈）
            </p>
          </article>
        )}
      </main>
    </div>
      </div>
    </div>
  );
}
