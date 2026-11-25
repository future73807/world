/**
 * Shared map artwork: the rounded blue player arrow, the fillet helper and the
 * baked cloud fog used by both the HUD minimap and the full-screen map.
 */

type P = [number, number];

/** Polygon whose every corner is rounded by `radius` (quadratic fillets). */
export function roundedPolygon(ctx: CanvasRenderingContext2D, pts: P[], radius: number) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const aPrev = Math.atan2(prev[1] - p[1], prev[0] - p[0]);
    const aNext = Math.atan2(next[1] - p[1], next[0] - p[0]);
    // a fillet may never eat more than the shorter adjacent edge
    const lenPrev = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
    const lenNext = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, lenPrev * 0.45, lenNext * 0.45);
    const sx = p[0] + Math.cos(aPrev) * r;
    const sy = p[1] + Math.sin(aPrev) * r;
    const ex = p[0] + Math.cos(aNext) * r;
    const ey = p[1] + Math.sin(aNext) * r;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
    ctx.quadraticCurveTo(p[0], p[1], ex, ey);
  }
  ctx.closePath();
}

/**
 * Player arrow: a rounded blue kite with a soft white halo, drawn pointing up
 * around the origin. Callers translate/rotate first.
 */
export function drawPlayerArrow(ctx: CanvasRenderingContext2D, len = 19) {
  const w = len * 0.8;

  const halo = ctx.createRadialGradient(0, 0, len * 0.2, 0, 0, len * 1.65);
  halo.addColorStop(0, 'rgba(255,255,255,0.55)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(0, 0, len * 1.65, 0, Math.PI * 2);
  ctx.fillStyle = halo;
  ctx.fill();

  ctx.beginPath();
  roundedPolygon(
    ctx,
    [
      [0, -len],
      [w, len * 0.58],
      [0, len * 0.24],
      [-w, len * 0.58],
    ],
    len * 0.3,
  );
  const g = ctx.createLinearGradient(0, -len, 0, len * 0.6);
  g.addColorStop(0, '#9deaff');
  g.addColorStop(0.45, '#46cff6');
  g.addColorStop(1, '#12a6df');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1.6, len * 0.12);
  ctx.strokeStyle = 'rgba(255,255,255,0.96)';
  ctx.stroke();

  // inner sheen so the arrow does not read as a flat sticker
  ctx.beginPath();
  roundedPolygon(
    ctx,
    [
      [0, -len * 0.58],
      [w * 0.42, len * 0.28],
      [0, len * 0.04],
      [-w * 0.42, len * 0.28],
    ],
    len * 0.16,
  );
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();
}

let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

let fogShape: HTMLCanvasElement | null = null;
let fogShapeJoined: HTMLCanvasElement | null = null;

/**
 * Bakes the SHAPE of the fog from the fog-of-war mask: a white sheet whose alpha
 * is the mask's, softened at the edges so coastlines and the frontier feather.
 *
 * The shape carries no cloud of its own. The cloud is drawn once, across the whole
 * view, by paintFogLayer, and this only says where it is lifted. An earlier version
 * painted cumulus into this sheet too, and where its square met the cloud field
 * outside it two different skies met at a hard rectangle — the faint lines running
 * the height and width of the map that kept being reported.
 */
export function bakeFog(explored: HTMLCanvasElement): HTMLCanvasElement {
  const pad = 16;
  const w = explored.width;
  const h = explored.height;
  if (!fogShape) fogShape = document.createElement('canvas');
  if (!fogShapeJoined) fogShapeJoined = document.createElement('canvas');
  fogShapeJoined.width = w + pad * 2;
  fogShapeJoined.height = h + pad * 2;
  // nine copies joined before any blur: blurred one at a time, each copy faded at
  // its own border and a darker valley ran along every seam
  const jctx = fogShapeJoined.getContext('2d')!;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) jctx.drawImage(explored, pad + i * w, pad + j * h);
  }
  // a light blur: the mask's own edges are the shape of the known world
  fogShape.width = w + pad * 2;
  fogShape.height = h + pad * 2;
  const ctx = fogShape.getContext('2d')!;
  ctx.filter = 'blur(2px)';
  ctx.drawImage(fogShapeJoined, 0, 0);
  ctx.filter = 'none';
  // flat white: only the alpha is read
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, fogShape.width, fogShape.height);
  ctx.globalCompositeOperation = 'source-over';
  // back to exactly the mask's own square (the pad was only for the blur)
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(fogShape, pad, pad, w, h, 0, 0, w, h);
  const span = (explored as HTMLCanvasElement & { worldSpan?: number }).worldSpan;
  (out as HTMLCanvasElement & { worldSpan?: number }).worldSpan = span;
  return out;
}

/**
 * THE fog layer, built for a whole view at once.
 *
 * The previous approach laid a finite cloud-mask square over an unbounded map and
 * painted a *different* cloud outside it. Two cloud fields of different tone
 * meeting at a hard rectangle is the visible square the user kept reporting.
 * There is no seam to hide when there is only ONE field: fill the entire view
 * with the seamless cloud tile, then punch the explored area out of it with
 * destination-out. The mask's own soft alpha becomes the fog's edge, so the
 * frontier feathers instead of stopping at a line.
 */
let fogLayerCanvas: HTMLCanvasElement | null = null;
let fogMaskCanvas: HTMLCanvasElement | null = null;
export function paintFogLayer(
  w: number,
  h: number,
  drawMask: (ctx: CanvasRenderingContext2D) => void,
  opts: { tileScale: number; originX: number; originY: number; maskRect: { x: number; y: number; w: number; h: number } },
): HTMLCanvasElement {
  let c = fogLayerCanvas;
  if (!c) {
    c = document.createElement('canvas');
    fogLayerCanvas = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  // one seamless cloud field over the whole view, pinned to the WORLD origin so
  // it pans with the map instead of sliding under it like a screen texture
  const tile = bakeCloudTile();
  const pat = ctx.createPattern(tile, 'repeat');
  if (pat) {
    const s = opts.tileScale;
    pat.setTransform?.(new DOMMatrix([s, 0, 0, s, opts.originX, opts.originY]));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = 'rgb(214, 232, 244)';
    ctx.fillRect(0, 0, w, h);
  }
  // one pale wash over the whole field: the minimap and the full map then cannot
  // disagree about the fog tone
  ctx.fillStyle = 'rgba(232, 244, 250, 0.55)';
  ctx.fillRect(0, 0, w, h);

  // Punch the explored area out. The mask's alpha is INVERTED relative to what
  // destination-out needs: the baked mask is ~1 over *unexplored* cloud and ~0
  // over walked ground, while destination-out erases by (1 - src.alpha). So the
  // mask is first inverted into a scratch canvas — without that step the fog
  // stayed over the walked island and vanished over the unknown sea, which is
  // exactly backwards.
  let inv = fogMaskCanvas;
  if (!inv) {
    inv = document.createElement('canvas');
    fogMaskCanvas = inv;
  }
  if (inv.width !== w || inv.height !== h) {
    inv.width = w;
    inv.height = h;
  }
  const ictx = inv.getContext('2d')!;
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.globalCompositeOperation = 'source-over';
  ictx.fillStyle = '#ffffff';
  ictx.fillRect(0, 0, w, h);
  // white minus mask = "walked" alpha
  ictx.globalCompositeOperation = 'destination-out';
  drawMask(ictx);
  ictx.globalCompositeOperation = 'source-over';
  // The mask's own border is the one place the cloud could thin: a copy drawn
  // edge to edge with the next one covers a seam pixel only half each, and a
  // line of sea showed through it. So the "walked" alpha is wiped outright in a
  // ring a pixel outside the mask, where nothing has been seen anyway.
  const r = opts.maskRect;
  const left = Math.floor(r.x) + 1;
  const top = Math.floor(r.y) + 1;
  const right = Math.ceil(r.x + r.w) - 1;
  const bottom = Math.ceil(r.y + r.h) - 1;
  const innerTop = Math.max(0, top);
  const innerH = Math.min(h, bottom) - innerTop;
  if (top > 0) ictx.clearRect(0, 0, w, top);
  if (bottom < h) ictx.clearRect(0, bottom, w, h - bottom);
  if (left > 0 && innerH > 0) ictx.clearRect(0, innerTop, left, innerH);
  if (right < w && innerH > 0) ictx.clearRect(right, innerTop, w - right, innerH);

  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(inv, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * A seamless tile of pure cloud, used to fill the map everywhere OUTSIDE the
 * fog mask's square. The mask is finite and the map sheet is not, so beyond the
 * mask there used to be no fog at all and unexplored terrain showed through —
 * "迷雾图层没有覆盖地图". The tile is drawn centred on each point and repeated
 * at ±size offsets, which makes its cloud lumps continuous.
 */
let cloudTile: HTMLCanvasElement | null = null;
export function bakeCloudTile(): HTMLCanvasElement {
  if (cloudTile) return cloudTile;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(214, 232, 244)';
  ctx.fillRect(0, 0, size, size);

  seed = 31;
  // draw each lump three times at ±size offsets so the tile wraps seamlessly in
  // both axes — a plain random speckle would show a grid of seams
  const n = 74;
  for (let i = 0; i < n; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 16 + rnd() * 44;
    const roll = rnd();
    let inner: string;
    let outer: string;
    if (roll < 0.42) {
      inner = 'rgba(255,255,255,0.9)';
      outer = 'rgba(255,255,255,0)';
    } else if (roll < 0.78) {
      inner = 'rgba(226,241,250,0.72)';
      outer = 'rgba(226,241,250,0)';
    } else {
      inner = 'rgba(196,221,236,0.5)';
      outer = 'rgba(196,221,236,0)';
    }
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox - r * 0.2, y + oy - r * 0.28, r * 0.05, x + ox, y + oy, r);
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  cloudTile = c;
  return c;
}

/**
 * The alpha mask of the minimap's rim: a disc whose edge is frayed like dry
 * brushwork — a few slow lobes, many fine teeth, and grain that lets single hairs
 * of the map reach further out than the rest. Baked once per size.
 */
let rimCache: { key: number; canvas: HTMLCanvasElement } | null = null;
export function raggedRim(size: number): HTMLCanvasElement {
  if (rimCache?.key === size) return rimCache.canvas;
  const S = size * 2; // baked at double resolution, so the teeth stay crisp on HiDPI screens
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;

  seed = 23;
  // (harmonics around the circle, amplitude as a share of the radius)
  const waves: [number, number, number][] = [
    [2, 0.028], [3, 0.03], [5, 0.02], [9, 0.014], [17, 0.011], [31, 0.009], [57, 0.007], [97, 0.0055], [161, 0.004],
  ].map(([k, a]) => [k, a, rnd() * Math.PI * 2]);
  // grain along the rim: value noise with 150 steps round the circle, so the hairs
  // run outward and keep their width, like a brush that is running dry
  const GN = 150;
  const grain = new Float32Array(GN);
  let acc = 0;
  for (let i = 0; i < GN; i++) {
    acc = acc * 0.55 + (rnd() * 2 - 1) * 0.6;
    grain[i] = acc;
  }
  const grainAt = (u: number) => {
    const f = ((u % 1) + 1) % 1 * GN;
    const i = Math.floor(f);
    const t = f - i;
    return grain[i] * (1 - t) + grain[(i + 1) % GN] * t;
  };

  const R = S / 2;
  const FEATHER = 0.05; // width of the fringe, as a share of the radius
  const BASE = 0.9; // where the fringe starts on average: the map keeps a clear middle
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - R) / R;
      const dy = (y + 0.5 - R) / R;
      const rho = Math.hypot(dx, dy);
      if (rho > 1.08) continue;
      const th = Math.atan2(dy, dx);
      let e = BASE;
      for (const [k, a, ph] of waves) e += a * Math.sin(k * th + ph);
      // the teeth only bite near the rim; further in the disc is solid
      const near = Math.min(1, Math.max(0, (rho - (e - FEATHER * 2.4)) / (FEATHER * 2.4)));
      const g = grainAt(th / (Math.PI * 2)) * near;
      const a = Math.min(1, Math.max(0, (e - rho) / FEATHER + 0.5 + g * 1.15));
      // smoothstep keeps the last of the alpha from ending in a hard line
      const o = (y * S + x) * 4;
      d[o] = 255;
      d[o + 1] = 255;
      d[o + 2] = 255;
      d[o + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  rimCache = { key: size, canvas: c };
  return c;
}
