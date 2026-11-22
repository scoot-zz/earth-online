// Aurora field rendering from NOAA SWPC's OVATION grid.
//
// The server action ships the OVATION model's probability grid as
// flat [lng, lat, prob] triples (only points with prob ≥ 2 — the
// field is essentially polar). Rendering (reworked after the first
// version blew the whole polar cap out to white on the user's
// phone):
//
//  1. Splat into a Float32 intensity grid with MAX compositing —
//     a pixel takes the strongest stamp covering it, never the sum.
//     The old additive splat stacked ~80 stamps per pixel (1° grid,
//     wide kernels) and saturated everything to white; near the
//     poles, where a degree of longitude shrinks to nothing, the
//     stacking was worst exactly where the user looked.
//  2. Kernels are physical: constant radius in latitude, widened in
//     longitude by 1/cos(lat) (clamped), and wrapped across the
//     antimeridian, so the oval stays a continuous band around the
//     pole instead of a disc with a seam.
//  3. A separable blur melts the 1° grid steps, then the field is
//     colourised through a probability transfer curve: below ~6%
//     essentially invisible, the mid range a deep aurora green, the
//     core bright mint — additive blending on the globe can no
//     longer reach white because the canvas itself never does.
//  4. Curtain rays: the colourised intensity is modulated by fine
//     streaks that run pole-to-equator (fast variation across
//     longitude, slow along latitude), the ray structure real
//     aurora curtains show.
//  5. Night mask: aurora is only *visible* in darkness, so the
//     field is multiplied by a twilight factor from the solar
//     altitude at the forecast time — full strength once the sun
//     is 12° below the horizon, gone in daylight. (OVATION's
//     probability itself is illumination-independent; the mask is
//     a visibility model, and the city readout below still reports
//     the raw model probability.)

import { solarAltitudeDeg } from "./solar";

const GW = 720; // intensity grid: 0.5° per cell
const GH = 360;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Probability (0–100) → field intensity 0–1 with a soft knee.
 *  Converged after the user's recording showed the oval blown out
 *  into a fluorescent green-white blob smeared over the whole polar
 *  cap and northern Canada: the knee now starts much later (below
 *  ~6% the field is invisible, full strength only from ~18%), the
 *  curve is steeper (pow 0.85) and the gain lower (×0.78), so only
 *  the oval's real core carries intensity and the wide low-
 *  probability skirt no longer paints half the Arctic. */
function probToIntensity(prob: number): number {
  if (prob <= 0) return 0;
  const t = Math.pow(prob / 100, 0.85);
  return Math.min(1, t * 0.78) * smoothstep(6, 18, prob);
}

/**
 * Deterministic streak field for the curtain rays: fast stripes
 * across longitude whose phase drifts slowly with latitude, plus a
 * finer harmonic. Value ~0.72–1.0 — a modulation, never a mask.
 */
function rayStreak(lngDeg: number, latDeg: number): number {
  const drift = Math.sin(latDeg * 0.11) * 2.4;
  const s1 = Math.sin(lngDeg * 2.9 + drift + Math.sin(lngDeg * 0.53) * 1.7);
  const s2 = Math.sin(lngDeg * 7.3 - drift * 1.6 + latDeg * 0.35);
  return 0.86 + 0.09 * s1 + 0.05 * s2;
}

export function buildAuroraCanvas(
  points: number[],
  when?: Date,
): HTMLCanvasElement | null {
  if (!points || points.length < 3) return null;
  const grid = new Float32Array(GW * GH);
  // ── Splat (max compositing, physical kernels, antimeridian wrap)
  // Kernel tightened with the intensity convergence: 1.9° of
  // latitude (was 3.1°) and the longitude widening clamped harder
  // near the poles (cos floor 0.28, cap 7° — was 0.12 / 13°), where
  // the old wide kernels smeared the oval into a filled cap.
  const R_LAT = 1.9; // kernel radius in degrees of latitude
  for (let i = 0; i + 2 < points.length; i += 3) {
    const lng = points[i] ?? 0;
    const lat = points[i + 1] ?? 0;
    const prob = points[i + 2] ?? 0;
    const inten = probToIntensity(prob);
    if (inten <= 0) continue;
    const cosLat = Math.max(0.28, Math.cos((lat * Math.PI) / 180));
    const rLng = Math.min(7, R_LAT / cosLat);
    const cx = ((lng + 180) / 360) * GW;
    const cy = ((90 - lat) / 180) * GH;
    const rxCells = Math.ceil((rLng / 360) * GW);
    const ryCells = Math.ceil((R_LAT / 180) * GH);
    for (let dy = -ryCells; dy <= ryCells; dy++) {
      const gy = Math.round(cy) + dy;
      if (gy < 0 || gy >= GH) continue;
      const ny = dy / ryCells;
      for (let dx = -rxCells; dx <= rxCells; dx++) {
        const nx = dx / rxCells;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const fall = Math.cos(Math.sqrt(d2) * Math.PI * 0.5);
        const v = inten * fall * fall;
        let gx = Math.round(cx) + dx;
        gx = ((gx % GW) + GW) % GW;
        const idx = gy * GW + gx;
        if (v > (grid[idx] ?? 0)) grid[idx] = v;
      }
    }
  }
  // ── Blur: two separable box passes (lng wraps, lat clamps) melt
  // the 1° sampling steps into a continuous field.
  const blur = (src: Float32Array, radius: number): Float32Array => {
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    const win = radius * 2 + 1;
    for (let y = 0; y < GH; y++) {
      const row = y * GW;
      for (let x = 0; x < GW; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += src[row + (((x + k) % GW) + GW) % GW] ?? 0;
        }
        tmp[row + x] = sum / win;
      }
    }
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.max(0, Math.min(GH - 1, y + k));
          sum += tmp[yy * GW + x] ?? 0;
        }
        dst[y * GW + x] = sum / win;
      }
    }
    return dst;
  };
  const field = blur(blur(grid, 2), 2);
  // ── Colourise: intensity → deep green → aurora green → mint
  // core, modulated by curtain rays and the night mask.
  const date = when && !Number.isNaN(when.getTime()) ? when : new Date();
  const out = document.createElement("canvas");
  out.width = GW;
  out.height = GH;
  const octx = out.getContext("2d");
  if (!octx) return null;
  const img = octx.createImageData(GW, GH);
  const px = img.data;
  for (let y = 0; y < GH; y++) {
    const lat = 90 - ((y + 0.5) / GH) * 180;
    for (let x = 0; x < GW; x++) {
      const idx = y * GW + x;
      const v0 = field[idx] ?? 0;
      if (v0 <= 0.004) continue;
      const lng = ((x + 0.5) / GW) * 360 - 180;
      // Night mask: visible once the sun is below the horizon,
      // full strength at −12° (nautical twilight's end).
      const alt = solarAltitudeDeg(lat, lng, date);
      const dark = smoothstep(1, -12, alt);
      if (dark <= 0.01) continue;
      const v = v0 * rayStreak(lng, lat) * dark;
      // Colour ramp (never white: red stays the weakest channel,
      // blue only joins at the core as a mint tint). Gains and the
      // alpha ceiling are roughly HALVED versus the first version —
      // under the globe shell's additive blending the old ramp
      // (green to 255, alpha to 0.92) summed into the fluorescent
      // green-white wash the user recorded; the core now peaks at a
      // deep aurora green and the field's alpha tops out at 0.55.
      const rC = 12 + 64 * Math.pow(v, 2.6);
      const gC = 26 + 118 * Math.pow(v, 1.25);
      const bC = 14 + 72 * Math.pow(v, 3.2);
      const aC = Math.min(0.55, v * 0.7);
      const o = idx * 4;
      px[o] = Math.min(255, rC);
      px[o + 1] = Math.min(255, gC);
      px[o + 2] = Math.min(255, bC);
      px[o + 3] = aC * 255;
    }
  }
  octx.putImageData(img, 0, 0);
  // Upscale ×2 with smoothing for the globe shell.
  const big = document.createElement("canvas");
  big.width = GW * 2;
  big.height = GH * 2;
  const bctx = big.getContext("2d");
  if (!bctx) return out;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(out, 0, 0, big.width, big.height);
  return big;
}

/**
 * Aurora probability at a place, read from the same OVATION grid:
 * the nearest shipped grid point within ~1.5°; 0 when the place is
 * outside every shipped point's neighbourhood (the grid only ships
 * prob ≥ 2 points, so "no neighbour" honestly means < 2%).
 */
export function auroraProbAt(
  points: number[],
  lat: number,
  lng: number,
): number {
  let best = Infinity;
  let bestV = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const pLng = points[i] ?? 0;
    const pLat = points[i + 1] ?? 0;
    let dLng = Math.abs(pLng - lng);
    if (dLng > 180) dLng = 360 - dLng;
    const d = dLng * dLng + (pLat - lat) * (pLat - lat);
    if (d < best) {
      best = d;
      bestV = points[i + 2] ?? 0;
    }
  }
  return best <= 2.25 ? bestV : 0;
}
