// Geostationary satellite cloud frame → equirectangular composer.
//
// Source: NASA GIBS WMTS (keyless, CORS-open — Access-Control-Allow-
// Origin: * verified live 2026-11-17), the geostationary "clean
// infrared" (Band 13) layers, published as EPSG:4326 tiles on a
// ~10-minute cadence ("default" time = the latest frame GIBS holds).
// Tile template, as published in GIBS's own capabilities document:
//
//   https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/<LAYER>/default/default/2km/3/{TileRow}/{TileCol}.png
//
// MULTI-DISK (this edit): the layer used to be the Himawari disk
// ALONE over a RainViewer base. When the RainViewer frame was thin
// or missing in the user's session, everything outside the Himawari
// disk — most visibly the EASTERN Pacific / Americas side — rendered
// as bare ocean with no clouds at all (the user's 「太平洋右侧没有
// 云层」 report, confirmed frame-by-frame in his recording: clouds
// stop dead at the Himawari limb). The composer now builds THREE
// geostationary disks, each from its own GIBS layer, and unions them
// into one equirect canvas:
//
//   · Himawari_AHI_Band13_Clean_Infrared — disk centred 140.7°E
//     (Asia / western Pacific), data columns 0–1, 6–9
//   · GOES-West_ABI_Band13_Clean_Infrared — disk centred 137.2°W
//     (eastern/central Pacific / western Americas), columns 0–3, 8–9
//   · GOES-East_ABI_Band13_Clean_Infrared — disk centred 75.2°W
//     (Americas / Atlantic), columns 0–5
//
// All three were verified 2026-11-18 against the live capabilities
// document (TileMatrixSet "2km", TileMatrix 3 = a 10×5 grid of 512px
// tiles, each spanning 36° × 36°; the TileMatrixSetLimits above are
// quoted from it) and by fetching real tiles: in-disk tiles return
// 30–370 KB of real imagery (GOES-West col 0: 367 KB, GOES-East
// col 2: 254 KB), out-of-disk columns return the 1,108-byte
// transparent placeholder and are never requested. A sampled
// GOES-West tile's brightness distribution (opaque-pixel median
// ≈ 101, cold tops to 255) matches Himawari's, so ONE
// brightness-temperature → alpha transfer serves all three disks.
// GIBS publishes NO Meteosat/SEVIRI infrared layer in its EPSG:4326
// WMTS (checked in the same capabilities document — zero matches),
// so the Europe/Africa sector between the Himawari and GOES-East
// limbs is filled by the caller's RainViewer global infrared mosaic
// underneath the disks, exactly as before. The three disks blend by
// view-geometry weights (see blendDisks(): source-over stacking
// double-counted the same clouds in disk-overlap bands and printed
// each limb on the globe as a bright vertical line), and App
// feathers the merged frame once more.
//
// Band 13 is brightness temperature rendered as greyscale: warm
// surface (land/ocean) sits around grey 95–125, cold cloud tops run
// 140–255. The composer turns that into a cloud ALPHA field — the
// warm-surface band becomes transparent, colder pixels become
// progressively opaque white — so what lands on the globe is the
// satellites' actual cloud field, not a grey wash over the disks.
// The alpha transfer is a smoothstep curve, not a linear ramp (the
// ramp's hard kink posterised thin cloud edges into contour steps).
// A frame with SOME disks still composes; a frame with none returns
// null and the caller falls back to RainViewer's global infrared
// mosaic alone. Complete frames are cached per 10-minute bucket;
// degraded ones (a disk lost to the network) only for 60s, and tile
// loads retry with backoff plus a hang timeout — see loadImage and
// composeGeoCloudFrame (edit #51).

const DRAW = 256; // drawn size in the composite (half of the 512px native tile → supersample)
const COLS = 10;
const ROWS = 5;
const W = COLS * DRAW; // 2560
const H = ROWS * DRAW; // 1280

interface GeoDisk {
  layer: string;
  /** Columns carrying disk data per the capabilities TileMatrixSetLimits. */
  cols: number[];
  /** Sub-satellite longitude (°) — the centre of the disk, used for
   *  the view-geometry blend weights in compose(). */
  centerLon: number;
}

const DISKS: GeoDisk[] = [
  {
    layer: "Himawari_AHI_Band13_Clean_Infrared",
    cols: [0, 1, 6, 7, 8, 9],
    centerLon: 140.7,
  },
  {
    layer: "GOES-West_ABI_Band13_Clean_Infrared",
    cols: [0, 1, 2, 3, 8, 9],
    centerLon: -137.2,
  },
  {
    layer: "GOES-East_ABI_Band13_Clean_Infrared",
    cols: [0, 1, 2, 3, 4, 5],
    centerLon: -75.2,
  },
];

function tileUrl(layer: string, row: number, col: number): string {
  return (
    "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/" +
    `${layer}/default/default/2km/3/${row}/${col}.png`
  );
}

function loadImageOnce(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    // A tile request that HANGS (neither load nor error — the flaky-
    // network case) must not wedge the whole composition forever:
    // after the timeout the attempt resolves null and the retry
    // logic below takes over.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.src = "";
      resolve(null);
    }, 20000);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

// Tile loads get two retries with backoff (edit #51). The failure
// this guards is not theoretical: when ONE disk's tiles fail in a
// session (the GIBS path from the user's network drops requests in
// bursts), compose() still succeeds from the remaining disks — and
// the strip where the missing disk was the only near-nadir view
// (for GOES-West: the central Pacific between GOES-East's west
// limb ≈156°W and Himawari's east limb ≈138°W) degrades to the
// average of two grazing, oppositely-displaced limb views: a
// washed, doubled vertical band at near-fixed longitudes — the
// user's 「云图竖线还在」 report on the post-#50 build, whose blend
// math itself re-verified clean against complete data (see
// DATA-PLAN #51). A per-tile retry converts most transient losses
// into successes inside the same composition.
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? 600 : 1800));
    }
    const img = await loadImageOnce(url);
    if (img) return img;
  }
  return null;
}

// Soften a canvas with down/up resample rounds so the alpha field
// melts instead of showing per-pixel steps (same trick as
// rainviewer.ts's feather). One pass per disk melts each disk's own
// limb; the union gets a final pass of its own.
function soften(src: HTMLCanvasElement, passes = 2): HTMLCanvasElement {
  let cur = src;
  for (let pass = 0; pass < passes; pass++) {
    const half = document.createElement("canvas");
    half.width = Math.max(2, Math.round(cur.width / 2));
    half.height = Math.max(2, Math.round(cur.height / 2));
    const hctx = half.getContext("2d");
    if (!hctx) return src;
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    const back = document.createElement("canvas");
    back.width = src.width;
    back.height = src.height;
    const bctx = back.getContext("2d");
    if (!bctx) return src;
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(half, 0, 0, back.width, back.height);
    cur = back;
  }
  return cur;
}

// View-geometry blend weight thresholds (cosines of the angle ρ
// between the pixel's direction and the satellite's sub-point):
// full weight inside ρ = 50°, easing to zero at the geometric limb
// ρ ≈ 81.3°. A disk's imagery degrades toward its limb (grazing
// view angle, foreshortening smear, cloud-top parallax against the
// neighbouring disk's near-nadir view), so the blend hands each
// region to the satellite that sees it most directly and cross-
// fades across the overlap instead of stepping at the limb.
const COS_RHO_FULL = Math.cos((50 * Math.PI) / 180); // ≈0.643
const COS_RHO_LIMB = Math.cos((81.3 * Math.PI) / 180); // ≈0.151

interface DiskField {
  /** Cloud alpha canvas (white RGB, alpha = cloud opacity). */
  alpha: HTMLCanvasElement;
  /** Blend-weight canvas: weight × 255 in the RED channel (alpha
   *  pinned 255 so soften()'s resampling averages the weight
   *  cleanly, with no premultiplication drift). Zero outside the
   *  disk and at the limb, full near the sub-satellite point. */
  weight: HTMLCanvasElement;
}

/** One satellite disk as a full equirect alpha canvas (transparent
 *  outside the disk) plus its blend-weight field, or null when none
 *  of its tiles loaded. */
async function composeDisk(disk: GeoDisk): Promise<DiskField | null> {
  const jobs: Array<Promise<{ img: HTMLImageElement | null; x: number; y: number }>> = [];
  for (let r = 0; r < ROWS; r++) {
    for (const c of disk.cols) {
      jobs.push(
        loadImage(tileUrl(disk.layer, r, c)).then((img) => ({ img, x: c, y: r })),
      );
    }
  }
  const tiles = await Promise.all(jobs);
  if (tiles.every((t) => t.img == null)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const t of tiles) {
    if (t.img) ctx.drawImage(t.img, t.x * DRAW, t.y * DRAW, DRAW, DRAW);
  }
  // Per-column cos(lon − centreLon) for the weight field (the row
  // factor cos(lat) is computed inline below).
  const colCos = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W) * 360 - 180;
    colCos[x] = Math.cos(((lon - disk.centerLon) * Math.PI) / 180);
  }
  const wCanvas = document.createElement("canvas");
  wCanvas.width = W;
  wCanvas.height = H;
  const wctx = wCanvas.getContext("2d", { willReadFrequently: true });
  if (!wctx) return null;
  const wData = wctx.createImageData(W, H);
  const wp = wData.data;
  // Brightness-temperature → cloud alpha. GIBS IR tiles are
  // greyscale (r=g=b) with alpha 0 outside the disk.
  const data = ctx.getImageData(0, 0, W, H);
  const px = data.data;
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const i = (rowBase + x) * 4;
      const a = px[i + 3] ?? 0;
      if (a === 0) continue;
      const v = px[i] ?? 0;
      // Warm surface ≈ ≤102 → invisible; cold tops ≥218 → near-solid,
      // joined by a smoothstep so thin-cloud edges shade continuously
      // instead of stepping at the old linear ramp's threshold kink.
      const t = Math.max(0, Math.min(1, (v - 102) / 116));
      const alpha = t * t * (3 - 2 * t) * 235;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = alpha;
      // Blend weight from the view angle: cos ρ = cos(lat) ·
      // cos(lon − centreLon) for a sub-satellite point on the
      // equator; smoothstepped between the full-weight and limb
      // cosines (monotonic in ρ, so no acos is needed).
      const cosRho = cosLat * (colCos[x] ?? 0);
      const s = Math.max(
        0,
        Math.min(1, (cosRho - COS_RHO_LIMB) / (COS_RHO_FULL - COS_RHO_LIMB)),
      );
      wp[i] = Math.round(s * s * (3 - 2 * s) * 255);
      wp[i + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  wctx.putImageData(wData, 0, 0);
  // One soften pass per disk, applied to BOTH fields alike: bleeds
  // the alpha a few pixels past the limb so the disk edge feathers
  // into its neighbours / the base mosaic instead of clipping clouds
  // along the limb circle, and feathers the weight identically so
  // the cross-fade stays smooth across the limb itself.
  return { alpha: soften(canvas, 1), weight: soften(wCanvas, 1) };
}

// Blend two or three disk fields by their view-geometry weights
// (normalised weighted average) — NOT source-over, NOT max. All
// three disks image the SAME cloud field minutes apart and from
// different directions, so in the overlap bands the samplings are
// displaced (scan-time offset + cloud-top parallax, worst near a
// limb where one view is grazing and smeared). Measured live
// 2026-11-22 by recomposing the real GIBS tiles with this file's
// own transfer curve: source-over stacking counted the same clouds
// two/three times (overlap strips averaged alpha 67–141 against
// 36–57 single-disk), and per-pixel MAX barely helped (54–124)
// because near-disjoint footprints still union into a denser
// field — both printed each disk's limb on the globe as a bright
// near-vertical line at a near-fixed longitude (Himawari east limb
// ≈138°W, GOES-West west limb ≈141°E, GOES-East west limb ≈156°W),
// the user's 「气象有几条明显的经度线」 report (a bright band
// across the Pacific). The weighted average keeps coincident
// clouds at their single-observation alpha, fades displaced copies
// to partial strength instead of doubling coverage, and hands each
// longitude to the most direct view smoothly: the same
// recomposition measured every limb strip at 39–51, continuous
// with the 36–57 of single-disk regions, and single-disk
// heartlands unchanged.
function blendDisks(fields: DiskField[]): HTMLCanvasElement | null {
  const blended = document.createElement("canvas");
  blended.width = W;
  blended.height = H;
  const bctx = blended.getContext("2d", { willReadFrequently: true });
  if (!bctx) return null;
  const alphas: Uint8ClampedArray[] = [];
  const weights: Uint8ClampedArray[] = [];
  for (const f of fields) {
    const actx = f.alpha.getContext("2d", { willReadFrequently: true });
    const wctx = f.weight.getContext("2d", { willReadFrequently: true });
    if (!actx || !wctx) return null;
    alphas.push(actx.getImageData(0, 0, W, H).data);
    weights.push(wctx.getImageData(0, 0, W, H).data);
  }
  const outData = bctx.createImageData(W, H);
  const op = outData.data;
  for (let i = 0; i < op.length; i += 4) {
    let sw = 0;
    let sa = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let d = 0; d < fields.length; d++) {
      // Weight lives in the weight canvas's RED channel (see
      // DiskField) — its alpha channel is not meaningful after
      // soften()'s premultiplied resampling.
      const w = (weights[d]?.[i] ?? 0) / 255;
      if (w <= 0) continue;
      const src = alphas[d];
      if (!src) continue;
      sw += w;
      sa += w * (src[i + 3] ?? 0);
      sr += w * (src[i] ?? 0);
      sg += w * (src[i + 1] ?? 0);
      sb += w * (src[i + 2] ?? 0);
    }
    if (sw <= 0) continue;
    op[i] = sr / sw;
    op[i + 1] = sg / sw;
    op[i + 2] = sb / sw;
    op[i + 3] = sa / sw;
  }
  bctx.putImageData(outData, 0, 0);
  return blended;
}

interface GeoFrame {
  canvas: HTMLCanvasElement;
  /** How many of the three disks actually contributed (post-retry).
   *  A frame below 3 is DEGRADED: somewhere on the globe a strip is
   *  covered only by grazing limb views (see loadImage's note) —
   *  the caller caches it only briefly so the next load recomposes
   *  instead of holding the degraded frame for the whole bucket. */
  disks: number;
}

async function compose(): Promise<GeoFrame | null> {
  const disks = await Promise.all(DISKS.map((d) => composeDisk(d)));
  const present = disks.filter((c): c is DiskField => c != null);
  if (present.length === 0) return null;
  // A lone disk needs no blend; two or three go through the
  // view-geometry weighted blend. A failed blend degrades to the
  // first disk alone rather than no clouds at all.
  const union =
    present.length === 1
      ? (present[0]?.alpha ?? null)
      : (blendDisks(present) ?? present[0]?.alpha ?? null);
  if (!union) return null;
  // Final frame at the globe's standard overlay size (2048×1024):
  // the 2560×1280 composite is already in equirect proportions
  // (36°×36° tiles), so this is a pure resample.
  const out = document.createElement("canvas");
  out.width = 2048;
  out.height = 1024;
  const octx = out.getContext("2d");
  if (!octx) return { canvas: soften(union, 1), disks: present.length };
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(union, 0, 0, out.width, out.height);
  return { canvas: soften(out, 1), disks: present.length };
}

let cached: {
  bucket: number;
  /** Epoch ms until which this entry may be reused. Full three-disk
   *  frames hold for the rest of the 10-minute bucket; degraded
   *  frames (a disk missing even after retries) expire after 60s so
   *  the caller's next load — the 5-minute refresh tick, or the
   *  layer being toggled — recomposes rather than re-serving the
   *  strip-degraded frame all bucket long. */
  expires: number;
  p: Promise<GeoFrame | null>;
} | null = null;

/** Compose (or reuse) the latest multi-disk geostationary cloud frame. */
export function composeGeoCloudFrame(): Promise<HTMLCanvasElement | null> {
  const bucket = Math.floor(Date.now() / 600000);
  if (cached && cached.bucket === bucket && Date.now() < cached.expires) {
    return cached.p.then((f) => f?.canvas ?? null);
  }
  const entry: NonNullable<typeof cached> = {
    bucket,
    // Provisional expiry: if the frame settles degraded (or null),
    // this is the real one — 60s, then recompose.
    expires: Date.now() + 60000,
    p: Promise.resolve(null),
  };
  entry.p = (async (): Promise<GeoFrame | null> => {
    let frame = await compose().catch(() => null);
    if (frame && frame.disks < DISKS.length) {
      // One immediate second attempt before settling for a degraded
      // frame: the tile-loss bursts this guards against are usually
      // seconds long, and the per-tile retries may already have
      // burned through the burst's front edge.
      await new Promise((r) => setTimeout(r, 2500));
      const again = await compose().catch(() => null);
      if (again && again.disks > frame.disks) frame = again;
    }
    if (frame && frame.disks >= DISKS.length) {
      // Complete frame: hold it for the rest of the bucket.
      entry.expires = (bucket + 1) * 600000;
    }
    return frame;
  })();
  cached = entry;
  return entry.p.then((f) => f?.canvas ?? null);
}
