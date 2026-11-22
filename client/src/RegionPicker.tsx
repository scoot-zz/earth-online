// Region drill-down picker: country → province/state → city/county.
//
// - 中国: provinces come from the DataV admin set (34 省级单位), the
//   second level lists that province's real prefecture-level units
//   (地级市/自治州/地区, municipalities list their districts). A unit
//   that exists in the built-in city library opens that city; any other
//   unit opens a weather card for the unit's own centre (DataV centre
//   coordinates, Asia/Shanghai) — real places, real coordinates.
// - 美国: all 50 states + DC, each with its full county-equivalent list
//   (3,143 counties from US Census TIGER boundaries, see us-regions.ts).
//   A county opens weather at its boundary centroid with timezone=auto
//   (Open-Meteo resolves the true local zone from the coordinates).
// - Other countries in the library: the library's own region → city
//   grouping.
// - ALL countries (全球行政区）: the geoBoundaries gbOpen dataset index
//   (assets/regions.ts, generated at build time from the dataset, not
//   hand-compiled) — 199 countries with their real first-level admin
//   regions and a representative point inside each region. Tapping a
//   region opens its weather at that point (tz auto); on the globe the
//   same dataset draws the region boundaries (ADM1 everywhere, ADM2
//   county-level at deep zoom), and any point can also be tapped
//   directly on the sphere.
//
// Picking a province/state only flies the globe there and drills in;
// weather opens on the city/county tap (or the explicit 首府/州府
// button inside the drilled view).

import { useEffect, useMemo, useState } from "react";
import { CITIES, type City } from "./cities";
import { PROVINCES, CITIES_BY_PROVINCE } from "./assets/china-admin";
import { GB_COUNTRIES, type GbCountry } from "./assets/gb-countries";
import type { GbAdm1 } from "./assets/regions";
import type { UsState } from "./us-regions";

export interface SubPlace {
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

type Nav =
  | { kind: "countries" }
  | { kind: "cn-provinces" }
  | { kind: "cn-cities"; province: string }
  | { kind: "us-states" }
  | { kind: "us-counties"; state: UsState }
  | { kind: "world-regions"; country: string }
  | { kind: "world-cities"; country: string; region: string }
  | { kind: "gb-countries" }
  | { kind: "gb-adm1"; country: GbCountry };

const MUNICIPALITIES = new Set(["北京", "天津", "上海", "重庆"]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function RegionPicker({
  onCity,
  onPlace,
  onFly,
}: {
  onCity: (city: City) => void;
  onPlace: (place: SubPlace, dist: number) => void;
  onFly: (lat: number, lng: number, dist: number) => void;
}) {
  const [nav, setNav] = useState<Nav>({ kind: "countries" });
  const [usStates, setUsStates] = useState<UsState[] | null>(null);
  const [gbAdm1, setGbAdm1] = useState<GbAdm1[] | null>(null);
  const [filter, setFilter] = useState("");

  // The US state/county data (~160 KB) loads only when the user
  // actually drills into 美国.
  useEffect(() => {
    if (nav.kind !== "us-states" && nav.kind !== "us-counties") return;
    if (usStates) return;
    let alive = true;
    void import("./us-regions").then((m) => {
      if (alive) setUsStates(m.US_STATES);
    });
    return () => {
      alive = false;
    };
  }, [nav.kind, usStates]);

  // Same for the geoBoundaries ADM1 index (~200 KB): only when the
  // user opens the 全球行政区 drill-down.
  useEffect(() => {
    if (nav.kind !== "gb-adm1") return;
    if (gbAdm1) return;
    let alive = true;
    void import("./assets/regions").then((m) => {
      if (alive) setGbAdm1(m.GB_ADM1);
    });
    return () => {
      alive = false;
    };
  }, [nav.kind, gbAdm1]);

  useEffect(() => {
    setFilter("");
  }, [nav]);

  const countries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of CITIES) counts.set(c.country, (counts.get(c.country) ?? 0) + 1);
    const list = [...counts.entries()].map(([name, count]) => ({ name, count }));
    list.sort((a, b) => {
      if (a.name === "中国") return -1;
      if (b.name === "中国") return 1;
      if (a.name === "美国") return -1;
      if (b.name === "美国") return 1;
      return b.count - a.count;
    });
    return list;
  }, []);

  const worldRegions = useMemo(() => {
    if (nav.kind !== "world-regions" && nav.kind !== "world-cities") return [];
    const country = nav.country;
    const regs = new Map<string, City[]>();
    for (const c of CITIES) {
      if (c.country !== country) continue;
      const arr = regs.get(c.region) ?? [];
      arr.push(c);
      regs.set(c.region, arr);
    }
    return [...regs.entries()]
      .map(([region, cities]) => ({ region, cities }))
      .sort((a, b) => b.cities.length - a.cities.length);
  }, [nav]);

  const crumbs: Array<{ label: string; nav: Nav }> = [{ label: "全部国家", nav: { kind: "countries" } }];
  if (nav.kind === "cn-provinces" || nav.kind === "cn-cities") {
    crumbs.push({ label: "中国", nav: { kind: "cn-provinces" } });
    if (nav.kind === "cn-cities") crumbs.push({ label: nav.province, nav });
  }
  if (nav.kind === "us-states" || nav.kind === "us-counties") {
    crumbs.push({ label: "美国", nav: { kind: "us-states" } });
    if (nav.kind === "us-counties") crumbs.push({ label: nav.state.zh, nav });
  }
  if (nav.kind === "world-regions" || nav.kind === "world-cities") {
    crumbs.push({ label: nav.country, nav: { kind: "world-regions", country: nav.country } });
    if (nav.kind === "world-cities") crumbs.push({ label: nav.region, nav });
  }
  if (nav.kind === "gb-countries" || nav.kind === "gb-adm1") {
    crumbs.push({ label: "全球行政区", nav: { kind: "gb-countries" } });
    if (nav.kind === "gb-adm1") crumbs.push({ label: nav.country.name, nav });
  }

  const rowBtn =
    "flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition-colors duration-200 hover:border-[var(--accent)]";
  const gridCls = "grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4";

  const pickCnUnit = (province: string, unitName: string, full: string, center: [number, number]) => {
    const lib = CITIES.find(
      (c) => c.country === "中国" && c.region === province && c.zh === unitName,
    );
    if (lib) {
      onCity(lib);
      return;
    }
    onPlace(
      {
        id: `sub:cn-${province}-${unitName}`,
        zh: full,
        en: full,
        country: "中国",
        region: province,
        lat: center[1],
        lng: center[0],
        tz: "Asia/Shanghai",
        wiki: full,
      },
      1.5,
    );
  };

  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1.5">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden="true" className="text-[var(--dim)]">›</span>}
            <button
              type="button"
              aria-label={`返回${c.label}`}
              onClick={() => setNav(c.nav)}
              className={`font-console min-h-9 px-2 py-1 text-xs transition-colors duration-200 ${
                i === crumbs.length - 1
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)] underline-offset-2 hover:underline"
              }`}
            >
              {c.label}
            </button>
          </span>
        ))}
        <span className="font-console ml-auto text-[11px] text-[var(--dim)]">
          {nav.kind === "countries" && "选国家 → 省/州 → 市/县，点市或县看当地实时天气"}
          {nav.kind === "cn-provinces" && "点省份飞过去并展开它的地级市"}
          {nav.kind === "cn-cities" && "点城市看天气"}
          {nav.kind === "us-states" && "点州飞过去并展开它的全部县"}
          {nav.kind === "us-counties" && "点县看天气（县中心点）"}
          {(nav.kind === "world-regions" || nav.kind === "world-cities") && "点城市看天气"}
          {nav.kind === "gb-countries" && "全球行政区数据集（geoBoundaries）：选国家看它的一级行政区"}
          {nav.kind === "gb-adm1" && "点行政区看当地实时天气（该区域内代表点）"}
        </span>
      </div>

      <div data-scroll-allow className="console-scroll mt-2 max-h-[46vh] overflow-y-auto pr-0.5">
        {/* ── Countries ─────────────────────────────────────────── */}
        {nav.kind === "countries" && (
          <>
          <button
            type="button"
            aria-label="浏览全球全部国家与一级行政区"
            onClick={() => setNav({ kind: "gb-countries" })}
            className="mb-1.5 flex min-h-11 w-full items-center gap-2 rounded-[var(--radius)] border border-[var(--accent)]/60 bg-[var(--accent)]/[0.07] px-3 py-2 text-left transition-colors duration-200"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              全球行政区 · 全部 {GB_COUNTRIES.length} 个国家/地区
            </span>
            <span className="font-console shrink-0 text-[11px] text-[var(--accent)]">
              省/州一级全覆盖 ›
            </span>
          </button>
          <div className={gridCls}>
            {countries.map(({ name, count }) => (
              <button
                key={name}
                type="button"
                aria-label={`选择${name}`}
                onClick={() => {
                  if (name === "中国") {
                    setNav({ kind: "cn-provinces" });
                    onFly(34.5, 104, 2.95);
                  } else if (name === "美国") {
                    setNav({ kind: "us-states" });
                    onFly(39, -98, 3.1);
                  } else {
                    const regs = new Map<string, number>();
                    for (const c of CITIES) {
                      if (c.country === name) regs.set(c.region, (regs.get(c.region) ?? 0) + 1);
                    }
                    if (regs.size <= 1) {
                      const only = [...regs.keys()][0];
                      if (only) setNav({ kind: "world-cities", country: name, region: only });
                    } else {
                      setNav({ kind: "world-regions", country: name });
                    }
                    const first = CITIES.find((c) => c.country === name);
                    if (first) onFly(first.lat, first.lng, 2.95);
                  }
                }}
                className={rowBtn}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                  {name === "中国"
                    ? "34 省 ›"
                    : name === "美国"
                      ? "51 州 ›"
                      : `${count} 城 ›`}
                </span>
              </button>
            ))}
          </div>
          </>
        )}

        {/* ── China: provinces ──────────────────────────────────── */}
        {nav.kind === "cn-provinces" && (
          <div className={gridCls}>
            {PROVINCES.map((p) => {
              const unitCount = CITIES_BY_PROVINCE[p.name]?.length ?? 0;
              return (
                <button
                  key={p.name}
                  type="button"
                  aria-label={`选择${p.full}`}
                  onClick={() => {
                    setNav({ kind: "cn-cities", province: p.name });
                    if (p.center) onFly(p.center[1], p.center[0], 1.92);
                  }}
                  className={rowBtn}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.full}</span>
                  <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                    {unitCount > 0 ? `${unitCount} 个市/区 ›` : "城市 ›"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── China: prefecture units of one province ───────────── */}
        {nav.kind === "cn-cities" && (
          <>
            {(() => {
              const units = CITIES_BY_PROVINCE[nav.province] ?? [];
              const capital = !MUNICIPALITIES.has(nav.province) ? units[0] : undefined;
              const capCenter = capital?.center ?? null;
              if (!capital || !capCenter) return null;
              return (
                <button
                  type="button"
                  aria-label={`看省会${capital.full}的天气`}
                  onClick={() => pickCnUnit(nav.province, capital.name, capital.full, capCenter)}
                  className="mb-1.5 flex min-h-11 w-full items-center gap-2 rounded-[var(--radius)] border border-[var(--accent)]/60 bg-[var(--accent)]/[0.07] px-3 py-2 text-left transition-colors duration-200"
                >
                  <span className="text-sm font-medium">省会 · {capital.full}</span>
                  <span className="font-console text-[11px] text-[var(--accent)]">直接看天气 ›</span>
                </button>
              );
            })()}
            <div className={gridCls}>
              {(CITIES_BY_PROVINCE[nav.province] ?? []).map((u) => (
                <button
                  key={u.full}
                  type="button"
                  aria-label={`看${u.full}的天气`}
                  disabled={!u.center}
                  onClick={() => u.center && pickCnUnit(nav.province, u.name, u.full, u.center)}
                  className={rowBtn}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{u.full}</span>
                  <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
                </button>
              ))}
              {/* Library cities of this province with no admin unit
                  (notably 台湾, whose unit file is empty). */}
              {CITIES.filter(
                (c) =>
                  c.country === "中国" &&
                  c.region === nav.province &&
                  !(CITIES_BY_PROVINCE[nav.province] ?? []).some((u) => u.name === c.zh),
              ).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`看${c.zh}的天气`}
                  onClick={() => onCity(c)}
                  className={rowBtn}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{c.zh}</span>
                  <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── US: states ────────────────────────────────────────── */}
        {nav.kind === "us-states" &&
          (usStates == null ? (
            <p className="py-6 text-center text-sm text-[var(--dim)]">正在加载美国州/县名录…</p>
          ) : (
            <div className={gridCls}>
              {usStates.map((s) => (
                <button
                  key={s.fips}
                  type="button"
                  aria-label={`选择${s.zh}`}
                  onClick={() => {
                    setNav({ kind: "us-counties", state: s });
                    onFly(s.capLat, s.capLng, 2.3);
                  }}
                  className={rowBtn}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.zh}</span>
                    <span className="font-console block truncate text-[10px] text-[var(--dim)]">{s.en}</span>
                  </span>
                  <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                    {s.counties.length} 县 ›
                  </span>
                </button>
              ))}
            </div>
          ))}

        {/* ── US: counties of one state ─────────────────────────── */}
        {nav.kind === "us-counties" && (
          <>
            <button
              type="button"
              aria-label={`看州府${nav.state.cap}的天气`}
              onClick={() =>
                onPlace(
                  {
                    id: `sub:us-${nav.state.fips}-capital`,
                    zh: nav.state.cap,
                    en: nav.state.cap,
                    country: "美国",
                    region: nav.state.zh,
                    lat: nav.state.capLat,
                    lng: nav.state.capLng,
                    tz: "auto",
                    wiki:
                      nav.state.fips === "11"
                        ? "Washington, D.C."
                        : `${nav.state.cap}, ${nav.state.en}`,
                  },
                  1.5,
                )
              }
              className="mb-1.5 flex min-h-11 w-full items-center gap-2 rounded-[var(--radius)] border border-[var(--accent)]/60 bg-[var(--accent)]/[0.07] px-3 py-2 text-left transition-colors duration-200"
            >
              <span className="text-sm font-medium">州府 · {nav.state.cap}</span>
              <span className="font-console text-[11px] text-[var(--accent)]">直接看天气 ›</span>
            </button>
            {/* Library cities in this state first — they carry proper
                names/zones in the library. */}
            {CITIES.filter((c) => c.country === "美国" && c.region === nav.state.zh).length > 0 && (
              <>
                <p className="font-console mt-1 mb-1.5 text-[11px] tracking-[0.14em] text-[var(--dim)]">
                  主要城市
                </p>
                <div className={`${gridCls} mb-2`}>
                  {CITIES.filter((c) => c.country === "美国" && c.region === nav.state.zh).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-label={`看${c.zh}的天气`}
                      onClick={() => onCity(c)}
                      className={rowBtn}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {c.zh}
                        <span className="font-console ml-1.5 text-[10px] text-[var(--dim)]">{c.en}</span>
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="font-console mt-1 mb-1.5 text-[11px] tracking-[0.14em] text-[var(--dim)]">
              全部县（{nav.state.counties.length}）
            </p>
            {nav.state.counties.length > 40 && (
              <input
                type="search"
                value={filter}
                aria-label={`在${nav.state.zh}内搜索县名`}
                placeholder="输入县名筛选，如 Los / Travis…"
                onChange={(e) => setFilter(e.target.value)}
                className="mb-1.5 min-h-10 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
              />
            )}
            <div className={gridCls}>
              {nav.state.counties
                .filter((c) => !filter.trim() || c.n.toLowerCase().includes(filter.trim().toLowerCase()))
                .map((c) => (
                  <button
                    key={c.n}
                    type="button"
                    aria-label={`看${c.n}的天气`}
                    onClick={() =>
                      onPlace(
                        {
                          id: `sub:us-${nav.state.fips}-${slugify(c.n)}`,
                          zh: c.n,
                          en: c.n,
                          country: "美国",
                          region: nav.state.zh,
                          lat: c.lat,
                          lng: c.lng,
                          tz: "auto",
                          wiki:
                            nav.state.fips === "11"
                              ? "Washington, D.C."
                              : `${c.n}, ${nav.state.en}`,
                        },
                        1.5,
                      )
                    }
                    className={rowBtn}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{c.n}</span>
                    <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
                  </button>
                ))}
            </div>
            {filter.trim() &&
              nav.state.counties.every(
                (c) => !c.n.toLowerCase().includes(filter.trim().toLowerCase()),
              ) && (
                <p className="py-4 text-center text-sm text-[var(--dim)]">
                  {nav.state.zh}没有名字含「{filter.trim()}」的县
                </p>
              )}
          </>
        )}

        {/* ── Other countries: regions ──────────────────────────── */}
        {nav.kind === "world-regions" && (
          <div className={gridCls}>
            {worldRegions.map(({ region, cities }) => (
              <button
                key={region}
                type="button"
                aria-label={`选择${region}`}
                onClick={() => {
                  setNav({ kind: "world-cities", country: nav.country, region });
                  const first = cities[0];
                  if (first) onFly(first.lat, first.lng, 2.3);
                }}
                className={rowBtn}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{region}</span>
                <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                  {cities.length} 城 ›
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── Other countries: cities ───────────────────────────── */}
        {nav.kind === "world-cities" && (
          <div className={gridCls}>
            {(worldRegions.find((r) => r.region === nav.region)?.cities ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={`看${c.zh}的天气`}
                onClick={() => onCity(c)}
                className={rowBtn}
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {c.zh}
                  <span className="font-console ml-1.5 text-[10px] text-[var(--dim)]">{c.en}</span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
            ))}
          </div>
        )}
        {/* ── geoBoundaries: all countries ──────────────────────── */}
        {nav.kind === "gb-countries" && (
          <>
            <input
              type="search"
              value={filter}
              aria-label="筛选国家或地区（英文名）"
              placeholder="输入国家英文名筛选，如 France / Japan / Brazil…"
              onChange={(e) => setFilter(e.target.value)}
              className="mb-1.5 min-h-10 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
            />
            <div className={gridCls}>
              {GB_COUNTRIES.filter(
                (c) =>
                  !filter.trim() ||
                  c.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
                  c.iso.toLowerCase() === filter.trim().toLowerCase(),
              ).map((c) => (
                <button
                  key={c.iso}
                  type="button"
                  aria-label={`选择${c.name}的行政区`}
                  onClick={() => {
                    setNav({ kind: "gb-adm1", country: c });
                    const [mnx, mny, mxx, mxy] = c.bbox;
                    const span = Math.max(mxx - mnx, mxy - mny);
                    const lat = Math.max(-58, Math.min(66, (mny + mxy) / 2));
                    let lng = (mnx + mxx) / 2;
                    if (lng > 180) lng -= 360;
                    onFly(lat, lng, span > 60 ? 3.2 : span > 25 ? 2.8 : span > 10 ? 2.4 : 2.1);
                  }}
                  className={rowBtn}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="font-console block truncate text-[10px] text-[var(--dim)]">{c.iso}</span>
                  </span>
                  <span className="font-console shrink-0 text-[11px] text-[var(--dim)]">
                    {c.c1} 区 ›
                  </span>
                </button>
              ))}
            </div>
            {filter.trim() &&
              GB_COUNTRIES.every(
                (c) => !c.name.toLowerCase().includes(filter.trim().toLowerCase()),
              ) && (
                <p className="py-4 text-center text-sm text-[var(--dim)]">
                  没有名字含「{filter.trim()}」的国家/地区
                </p>
              )}
          </>
        )}

        {/* ── geoBoundaries: ADM1 regions of one country ────────── */}
        {nav.kind === "gb-adm1" &&
          (gbAdm1 == null ? (
            <p className="py-6 text-center text-sm text-[var(--dim)]">正在加载全球行政区名录…</p>
          ) : (
            <>
              {(() => {
                const isoIdx = GB_COUNTRIES.findIndex((c) => c.iso === nav.country.iso);
                const entries = gbAdm1
                  .map((r, i) => ({ r, i }))
                  .filter(({ r }) => r[0] === isoIdx);
                return (
                  <>
                    {entries.length > 40 && (
                      <input
                        type="search"
                        value={filter}
                        aria-label={`在${nav.country.name}内筛选行政区`}
                        placeholder="输入行政区名筛选…"
                        onChange={(e) => setFilter(e.target.value)}
                        className="mb-1.5 min-h-10 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
                      />
                    )}
                    <div className={gridCls}>
                      {entries
                        .filter(
                          ({ r }) =>
                            !filter.trim() ||
                            r[1].toLowerCase().includes(filter.trim().toLowerCase()),
                        )
                        .map(({ r, i }) => (
                          <button
                            key={i}
                            type="button"
                            aria-label={`看${r[1]}的天气`}
                            onClick={() =>
                              onPlace(
                                {
                                  id: `gb:${nav.country.iso}-${i}`,
                                  zh: r[1],
                                  en: r[1],
                                  country: nav.country.name,
                                  region: r[1],
                                  lat: r[2],
                                  lng: r[3],
                                  tz: "auto",
                                  wiki: r[1],
                                },
                                1.9,
                              )
                            }
                            className={rowBtn}
                          >
                            <span className="min-w-0 flex-1 truncate text-sm">{r[1]}</span>
                            <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
                          </button>
                        ))}
                    </div>
                    {entries.length === 0 && (
                      <p className="py-4 text-center text-sm text-[var(--dim)]">
                        该国家/地区在数据集中没有一级行政区条目 — 可以直接在地球上点选它的任意位置看天气
                      </p>
                    )}
                  </>
                );
              })()}
            </>
          ))}
      </div>
    </div>
  );
}
