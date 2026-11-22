// Solar geometry for 追霞模式 (sunset chasing).
//
// Everything here is computed from first principles (the standard
// NOAA solar-position approximation): the sun's declination and the
// local hour angle give the solar altitude for any coordinate at any
// instant. The twilight band is altitude ∈ [-6°, +1°] on the EVENING
// side (hour angle > 0, i.e. after local solar noon) — the morning
// band at the same altitudes is dawn, not dusk, and is excluded by
// the hour-angle sign. No data is fetched for any of this; it is pure
// astronomy over the built-in city library.

const RAD = Math.PI / 180;

interface SunCoords {
  decDeg: number;
  raDeg: number;
  gmstDeg: number;
}

function sunCoords(date: Date): SunCoords {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLong = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const meanAnom = (((357.528 + 0.9856003 * n) % 360) + 360) % 360;
  const g = meanAnom * RAD;
  const eclLong =
    (meanLong + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const raDeg =
    Math.atan2(Math.cos(eps) * Math.sin(eclLong), Math.cos(eclLong)) / RAD;
  const decDeg = Math.asin(Math.sin(eps) * Math.sin(eclLong)) / RAD;
  const gmstDeg =
    (((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360) + 360) % 360;
  return { decDeg, raDeg, gmstDeg };
}

function norm180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Solar altitude in degrees at (lat, lng) at `date` (negative = below horizon). */
export function solarAltitudeDeg(lat: number, lng: number, date: Date): number {
  const { decDeg, raDeg, gmstDeg } = sunCoords(date);
  const hourAngle = norm180(gmstDeg + lng - raDeg);
  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(decDeg * RAD) +
    Math.cos(lat * RAD) * Math.cos(decDeg * RAD) * Math.cos(hourAngle * RAD);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

/** Local hour angle in degrees: > 0 means afternoon/evening (sun descending). */
export function solarHourAngleDeg(lng: number, date: Date): number {
  const { raDeg, gmstDeg } = sunCoords(date);
  return norm180(gmstDeg + lng - raDeg);
}

/** The subsolar point (where the sun is exactly overhead) at `date`. */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const { decDeg, raDeg, gmstDeg } = sunCoords(date);
  return { lat: decDeg, lng: norm180(raDeg - gmstDeg) };
}

export interface TwilightInfo {
  altitude: number;
  /** Evening side of the day (sun descending toward / past sunset). */
  evening: boolean;
  /** Altitude within the twilight band [-6°, +1°] on the evening side. */
  inTwilight: boolean;
  /** Minutes until the sun crosses 0° (sunset), when it is still above the horizon on the evening side; else null. */
  minutesToSunset: number | null;
  /** Minutes until the sun crosses -6° (end of civil twilight), when it is currently inside the band; else null. */
  minutesOfTwilightLeft: number | null;
}

function minutesUntilCrossing(
  lat: number,
  lng: number,
  from: Date,
  targetAlt: number,
): number | null {
  // Scan ahead in 4-minute steps (max 3h) for the downward crossing.
  let prevAlt = solarAltitudeDeg(lat, lng, from);
  if (prevAlt <= targetAlt) return 0;
  for (let m = 4; m <= 180; m += 4) {
    const t = new Date(from.getTime() + m * 60000);
    const alt = solarAltitudeDeg(lat, lng, t);
    if (alt <= targetAlt) {
      // Linear interpolation inside the final step.
      const frac = (prevAlt - targetAlt) / Math.max(1e-9, prevAlt - alt);
      return Math.round(m - 4 + 4 * frac);
    }
    prevAlt = alt;
  }
  return null;
}

export function twilightInfo(lat: number, lng: number, date: Date): TwilightInfo {
  const altitude = solarAltitudeDeg(lat, lng, date);
  const evening = solarHourAngleDeg(lng, date) > 0;
  const inTwilight = evening && altitude <= 1 && altitude >= -6;
  const minutesToSunset =
    evening && altitude > 0 ? minutesUntilCrossing(lat, lng, date, 0) : null;
  const minutesOfTwilightLeft = inTwilight
    ? minutesUntilCrossing(lat, lng, date, -6)
    : null;
  return { altitude, evening, inTwilight, minutesToSunset, minutesOfTwilightLeft };
}

export interface TwilightCity<T> {
  city: T;
  altitude: number;
}

/**
 * Cities of the library currently inside the evening twilight band,
 * best sunset first (altitude closest to -1°, sun just set / setting,
 * sky at its most colourful), then by altitude descending.
 */
export function findTwilightCities<T extends { lat: number; lng: number }>(
  cities: readonly T[],
  date: Date,
): Array<TwilightCity<T>> {
  const out: Array<TwilightCity<T>> = [];
  for (const city of cities) {
    const alt = solarAltitudeDeg(city.lat, city.lng, date);
    if (alt < -6 || alt > 1) continue;
    if (solarHourAngleDeg(city.lng, date) <= 0) continue;
    out.push({ city, altitude: alt });
  }
  out.sort(
    (a, b) =>
      Math.abs(a.altitude + 1) - Math.abs(b.altitude + 1) ||
      b.altitude - a.altitude,
  );
  return out;
}
