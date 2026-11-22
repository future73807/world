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

/**
 * Bakes a blurred, cloud-textured copy of the fog mask. Expensive (blur +
 * gradient blobs), so callers cache it and only rebuild when the mask changes.
 * Unknown ground reads as a soft white-blue cloud bank, like the reference map
 * where the uncharted area is a haze of cumulus rather than a grey rectangle.
 */
export function bakeFog(explored: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = explored.width;
  c.height = explored.height;
  const ctx = c.getContext('2d')!;

  // The mask is already smooth (radial-gradient stamps), so only a light blur is
  // needed. A wide one turned the explored island into a shapeless green smear.
  ctx.filter = 'blur(3px)';
  ctx.drawImage(explored, 0, 0);
  ctx.filter = 'none';

  // unexplored ground must barely read through. The whiten pass cannot RAISE
  // alpha — Chromium's 'source-atop' keeps the destination alpha — so the
  // near-opaque base has to come from the mask itself (see Game.initExploredMask).
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(236, 245, 250, 0.98)';
  ctx.fillRect(0, 0, c.width, c.height);

  // cloud lumps: bright cumulus highlights, cool shadow sides, fine speckle
  seed = 7;
  const n = 460;
  for (let i = 0; i < n; i++) {
    const x = rnd() * c.width;
    const y = rnd() * c.height;
    const r = 5 + rnd() * 22;
    const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.25, r * 0.06, x, y, r);
    const roll = rnd();
    if (roll < 0.4) {
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.62, 'rgba(255,255,255,0.3)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    } else if (roll < 0.76) {
      g.addColorStop(0, 'rgba(205,229,244,0.6)');
      g.addColorStop(1, 'rgba(205,229,244,0)');
    } else {
      g.addColorStop(0, 'rgba(163,199,220,0.44)');
      g.addColorStop(1, 'rgba(163,199,220,0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // FEATHER the edges. The mask is a finite square laid over an unbounded map;
  // with a hard edge the boundary showed as a bright rectangle floating in the
  // cloud field. Fading alpha to zero over the outermost ~4% lets the cloud
  // tile drawn underneath continue seamlessly.
  const feather = Math.max(8, Math.round(c.width * 0.04));
  const edge = document.createElement('canvas');
  edge.width = c.width;
  edge.height = c.height;
  const ectx = edge.getContext('2d')!;
  ectx.fillStyle = '#ffffff';
  ectx.fillRect(0, 0, c.width, c.height);
  const fade = (x0: number, y0: number, x1: number, y1: number, horizontal: boolean) => {
    const g = horizontal
      ? ectx.createLinearGradient(x0, 0, x1, 0)
      : ectx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ectx.fillStyle = g;
    if (horizontal) ectx.fillRect(Math.min(x0, x1), 0, feather, c.height);
    else ectx.fillRect(0, Math.min(y0, y1), c.width, feather);
  };
  fade(0, 0, feather, 0, true);
  fade(c.width, 0, c.width - feather, 0, true);
  fade(0, 0, 0, feather, false);
  fade(0, c.height, 0, c.height - feather, false);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(edge, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  (c as HTMLCanvasElement & { worldSpan?: number }).worldSpan =
    (explored as HTMLCanvasElement & { worldSpan?: number }).worldSpan;
  return c;
}

/**
 * Fills everything on a canvas EXCEPT the given rectangle with `style`, using
 * even-odd winding. This is how the map gets fog everywhere the finite mask
 * cannot reach: the four-rect approach left uncovered corners whenever the mask
 * slid off-screen, which is why unexplored terrain used to show past the fog.
 */
export function fillOutsideRect(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  style: string | CanvasPattern,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  // the inner rect is wound the other way, so even-odd leaves it empty
  ctx.moveTo(rx, ry);
  ctx.lineTo(rx, ry + rh);
  ctx.lineTo(rx + rw, ry + rh);
  ctx.lineTo(rx + rw, ry);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill('evenodd');
  ctx.restore();
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
