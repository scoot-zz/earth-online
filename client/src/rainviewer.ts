// RainViewer tile → equirectangular composer.
//
// RainViewer serves weather tiles in Web-Mercator slippy format
// ({host}{path}/256/{z}/{x}/{y}/...). The globe's sphere uses an
// equirectangular texture, so a frame is composed client-side: at
// zoom 3 the world is 8×8 tiles; each tile is drawn into a
// 2048×1024 canvas in 16 horizontal strips, with each strip's
// destination latitude converted Mercator → geographic, so radar
// echoes land at their true latitudes instead of being stretched
// toward the poles. Tiles are CORS-open (Access-Control-Allow-Origin:
// *), so the canvas stays clean and can be uploaded as a WebGL
// texture. Composed frames are cached by path+style — the playback
// loop reuses them instead of re-fetching 64 tiles per frame.
//
// Why zoom 3 (edit 2026-11-17): zoom 2's 1024×512 composite made
// every echo a fist-sized block and drew the infrared cloud frame as
// grey mosaic squares along the coasts — the user's 「降水丑 / 海边
// 马赛克」 complaint. Zoom 3 quadruples the pixels. Verified live:
// all 64 tile positions return 200, and a z3 East-Asia tile carries
// visibly finer echo structure than its z2 counterpart. Note the
// colour-scheme URL segment is IGNORED by RainViewer's current
// hash-path tile service (schemes 0/1/2/4/6/7 returned byte-identical
// tiles in a live probe; only the smooth/snow options segment still
// changes the render), so the alternative precipitation look the
// user asked for cannot come from a scheme switch — it is done
// here, as a render style:
//
//   "crisp" — the tiles as served: hard-edged classic radar blocks.
//   "soft"  — the composed frame is melted through two down/up
//             resample passes, so echoes feather into soft weather
//             systems (Windy-style) instead of pixel blocks.
// The satellite infrared frame is ALWAYS feathered the same way:
// cloud fields must never show tile-grid edges, and at any zoom the
// IR source is coarse enough to read as mosaic without it.
//
// Any failure (network, a missing tile) degrades quietly: a frame
// with SOME tiles still composes (missing tiles stay transparent);
// a frame with NO tiles returns null and the caller hides the layer.

export type RainKind = "radar" | "satellite";
export type RainStyle = "crisp" | "soft";

const ZOOM = 3;
const TILES = 2 ** ZOOM; // 8
const TILE = 256;
const CANVAS_W = TILES * TILE; // 2048
const CANVAS_H = CANVAS_W / 2; // 1024
const STRIPS = 16;

const cache = new Map<string, Promise<HTMLCanvasElement | null>>();

function tileUrl(
  host: string,
  path: string,
  kind: RainKind,
  x: number,
  y: number,
): string {
  // RainViewer path grammar: radar uses colour scheme 2 (universal
  // blue) with options 1_1 (smooth + snow); satellite infrared uses
  // scheme 0 with options 0_0. (The scheme segment is currently
  // ignored server-side — see the header note — but the grammar is
  // kept correct for when it matters again.)
  return kind === "radar"
    ? `${host}${path}/256/${ZOOM}/${x}/${y}/2/1_1.png`
    : `${host}${path}/256/${ZOOM}/${x}/${y}/0/0_0.png`;
}

function loadImageOnce(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    // Same hang guard as himawari.ts: a tile request that neither
    // loads nor errors must not wedge the frame composition forever.
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

// Two retries with backoff, mirroring himawari.ts (edit #51): a
// tile lost to a transient burst otherwise leaves a 45°-wide
// rectangular hole in the composed frame for the frame's whole
// cache life — under the geostationary disks that hole reads as a
// differently-textured vertical strip wherever the disk view is
// grazing and thin.
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

// Inverse Web-Mercator: tile-space y fraction (0 = top) → latitude°.
function mercatorLat(yFrac: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI;
}

// Melt a composed frame: resample down to half size and back up
// (twice). Each down/up round is a cheap box blur over colour AND
// alpha, so single-pixel steps and tile seams dissolve into soft
// gradients while the echo shapes survive. Returns a new canvas;
// the input is left untouched. Exported so App can give the MERGED
// cloud frame (RainViewer mosaic + Himawari disk drawn over it) one
// final melt — the seam between the two sources, and the doubled
// edges where both image the same cloud a few minutes apart, only
// exist on the composite, so no per-source feather can hide them.
export function featherCanvas(
  src: HTMLCanvasElement,
  passes = 2,
): HTMLCanvasElement {
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

async function compose(
  host: string,
  path: string,
  kind: RainKind,
  style: RainStyle,
): Promise<HTMLCanvasElement | null> {
  const jobs: Array<Promise<{ img: HTMLImageElement | null; x: number; y: number }>> = [];
  for (let y = 0; y < TILES; y++) {
    for (let x = 0; x < TILES; x++) {
      const tx = x;
      const ty = y;
      jobs.push(
        loadImage(tileUrl(host, path, kind, tx, ty)).then((img) => ({
          img,
          x: tx,
          y: ty,
        })),
      );
    }
  }
  const tiles = await Promise.all(jobs);
  if (tiles.every((t) => t.img == null)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const stripH = TILE / STRIPS;
  for (const t of tiles) {
    if (!t.img) continue;
    for (let s = 0; s < STRIPS; s++) {
      const sy = s * stripH;
      const yFrac0 = (t.y * TILE + sy) / (TILES * TILE);
      const yFrac1 = (t.y * TILE + sy + stripH) / (TILES * TILE);
      const lat0 = mercatorLat(yFrac0);
      const lat1 = mercatorLat(yFrac1);
      const dy0 = ((90 - lat0) / 180) * CANVAS_H;
      const dy1 = ((90 - lat1) / 180) * CANVAS_H;
      ctx.drawImage(
        t.img,
        0,
        sy,
        TILE,
        stripH,
        t.x * TILE,
        dy0,
        TILE,
        Math.max(0.6, dy1 - dy0),
      );
    }
  }
  // Satellite cloud fields always feather; radar feathers only in
  // the "soft" display style (crisp keeps the served blocks).
  if (kind === "satellite" || style === "soft") return featherCanvas(canvas);
  return canvas;
}

/** Compose (or fetch from cache) one RainViewer frame as an equirect canvas. */
export function composeRainFrame(
  host: string,
  path: string,
  kind: RainKind,
  style: RainStyle = "crisp",
): Promise<HTMLCanvasElement | null> {
  // Satellite ignores the style choice (always feathered) — fold it
  // into the key so it shares one cache entry.
  const key = `${kind}:${kind === "satellite" ? "soft" : style}:${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = compose(host, path, kind, style).catch(() => null);
  cache.set(key, p);
  return p;
}
