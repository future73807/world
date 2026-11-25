import { useEffect, useMemo, useRef, useState } from 'react';
import { bakeFog, drawPlayerArrow, paintFogLayer } from '../lib/mapArt';
import { mapPainter } from '../game/terrain';
import { IslandField, TILE } from '../game/world';
import { IconClose } from './icons';
import type { TileGrid } from './Hud';

/** The part of the world the player has seen, as a rectangle in BU. */
export interface ExploredBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

interface WorldMapProps {
  /** height field, used to bake the sheet on demand */
  field: IslandField | null;
  fog: HTMLCanvasElement | null;
  fogSpan: number;
  fogVersion: number;
  /** the seen part of the world: the map may wander out to twice its reach, in every direction */
  bounds: ExploredBounds | null;
  px: number;
  pz: number;
  yaw: number;
  /** the tile being generated right now, if any */
  grid?: TileGrid;
  onClose: () => void;
}

interface Sheet {
  cx: number;
  cz: number;
  /** BU the sheet covers, edge to edge */
  span: number;
  canvas: HTMLCanvasElement;
  /** false while the sheet is still being painted, row by row */
  done: boolean;
}

const BAKE_PX = 1024; // resolution the sheet is baked at
const BASE_ZOOM = 118; // BU across the shorter screen axis at zoom 1
const ZOOM_MAX = 4;
const ZOOM_MIN_SPAN = 24; // the view never zooms out past this many BU
const MIN_SEEN = 120; // a seen area counts as at least this wide, so a fresh world still has room around it
const BAKE_ROWS = 36; // rows of the sheet painted per slice
const CLOUD_PX = 256; // edge of the seamless cloud tile, before scaling

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Full-screen map: a sheet of the world you pan and zoom, the player arrow at its
 * true position, and cloud over everything not yet seen. The sheet is bounded by
 * what has been seen — it can be dragged and zoomed out to twice the seen area,
 * and no further — and carries no lattice: the mist ends on coastlines, the only
 * mark on it is the tile being opened right now.
 */
export function WorldMap({
  field, fog, fogSpan, fogVersion, bounds, px, pz, yaw, grid, onClose,
}: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fogRef = useRef<{ version: number; canvas: HTMLCanvasElement } | null>(null);
  /** the sheet being shown (possibly still painting) and the last finished one underneath it */
  const sheetRef = useRef<Sheet | null>(null);
  const baseRef = useRef<Sheet | null>(null);
  const bakeGen = useRef(0);
  const bakeTimer = useRef(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: 0, z: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; cx: number; cz: number; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; zoom: number; mx: number; my: number; cx: number; cz: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const placed = useRef(false);

  // What the map may show: the seen world, and as much again around it — twice
  // its reach in every direction, so the sheet can be dragged just as far east as
  // north. (Clamping to the seen rectangle itself left a world that fitted the
  // frame with no room to move at all, and a long strip of one with room only up
  // and down.) Seen as a strip, the room is squared off, not stretched.
  const seen = useMemo(() => {
    const b = bounds ?? { x0: -MIN_SEEN / 2, z0: -MIN_SEEN / 2, x1: MIN_SEEN / 2, z1: MIN_SEEN / 2 };
    const span = Math.max(Math.max(b.x1 - b.x0, b.z1 - b.z0), MIN_SEEN);
    return { cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, hw: span, hh: span };
  }, [bounds]);

  /** BU the view shows at a zoom, across and down. */
  const viewBu = (z: number) => {
    const scale = Math.min(size.w, size.h) / (BASE_ZOOM / z);
    return { w: size.w / scale, h: size.h / scale };
  };
  /** the farthest out the view may go: when it fills the frame exactly */
  const zoomMin = useMemo(() => {
    const aspect = size.w / Math.max(1, size.h);
    const byW = (seen.hw * 2) / Math.max(1, aspect);
    const byH = (seen.hh * 2) / Math.max(1, 1 / aspect);
    return BASE_ZOOM / Math.max(ZOOM_MIN_SPAN, Math.min(byW, byH));
  }, [size.w, size.h, seen]);
  /** keeps the view inside the frame: the sheet moves, the frame does not */
  const clampCenter = (c: { x: number; z: number }, z: number) => {
    const v = viewBu(z);
    const mx = Math.max(0, seen.hw - v.w / 2);
    const mz = Math.max(0, seen.hh - v.h / 2);
    return { x: clamp(c.x, seen.cx - mx, seen.cx + mx), z: clamp(c.z, seen.cz - mz, seen.cz + mz) };
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // opening the map: the seen world with cloud around it, a step in from the
  // farthest zoom so there is room to drag in every direction from the start
  // (opened at the limit itself, the view already filled the frame across, and the
  // sheet would only move up and down)
  useEffect(() => {
    if (placed.current || size.w === 0) return;
    placed.current = true;
    const aspect = size.w / Math.max(1, size.h);
    const boxW = seen.hw * 2;
    // the view's longer axis takes 72% of the frame's width: 1.4× room either way
    const span = (boxW * 0.72) / Math.max(1, aspect);
    setZoom(clamp(BASE_ZOOM / span, zoomMin, 1.5));
    setCenter({ x: seen.cx, z: seen.cz });
  }, [size, seen, zoomMin]);

  // after any zoom, and whenever the frame itself changes: the view stays inside it
  useEffect(() => {
    setZoom((z) => {
      const c = clamp(z, zoomMin, ZOOM_MAX);
      return c === z ? z : c;
    });
    setCenter((c) => {
      const k = clampCenter(c, zoom);
      return k.x === c.x && k.z === c.z ? c : k;
    });
  }, [zoom, zoomMin, seen, size.w, size.h]);

  // The sheet bakes lazily and DEFERRED, in slices. While you drag, the pending
  // bake keeps being rescheduled, so the old sheet stays on screen and panning
  // never stutters; once you pause, a sheet fitted to the new view is painted a
  // few dozen rows at a time over the top of it.
  useEffect(() => {
    if (!field || size.w === 0) return;
    if (dragging || pinch.current) return; // never bake mid-gesture
    const cur = sheetRef.current;
    const v = viewBu(zoom);
    const need = Math.max(v.w, v.h);
    const covers =
      !!cur &&
      cur.span >= v.w &&
      cur.span >= v.h &&
      Math.abs(cur.cx - center.x) <= (cur.span - v.w) / 2 &&
      Math.abs(cur.cz - center.z) <= (cur.span - v.h) / 2;
    // a sheet may be up to about twice as wide as the view needs; beyond that it is too coarse to look at
    if (covers && cur!.span <= need * 2.1) return;
    window.clearTimeout(bakeTimer.current);
    bakeTimer.current = window.setTimeout(() => {
      const gen = ++bakeGen.current;
      // the sheet covers the view with room to pan inside it before another bake
      const span = Math.max(40, need * 1.6);
      const painter = mapPainter(field, BAKE_PX, span, center.x, center.z, true);
      const next: Sheet = { cx: center.x, cz: center.z, span, canvas: painter.canvas, done: false };
      sheetRef.current = next;
      setSheet(next);
      const slice = () => {
        if (gen !== bakeGen.current) return; // a newer view has taken over
        if (painter.step(BAKE_ROWS)) {
          painter.finish();
          const cur = sheetRef.current;
          if (cur) {
            cur.done = true;
            baseRef.current = cur;
          }
          setSheet({ ...sheetRef.current! });
          return;
        }
        setSheet({ ...next });
        window.setTimeout(slice, 0);
      };
      slice();
    }, 110);
    return () => window.clearTimeout(bakeTimer.current);
  }, [field, center.x, center.z, zoom, size.w, size.h, dragging, fogVersion]);

  useEffect(
    () => () => {
      // leaving the page abandons any sheet still being painted
      bakeGen.current++;
      window.clearTimeout(bakeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = size.w;
    const h = size.h;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    const span = BASE_ZOOM / zoom; // BU across the shorter screen axis
    const scale = Math.min(w, h) / span;
    const toX = (x: number) => w / 2 + (x - center.x) * scale;
    const toY = (z: number) => h / 2 + (z - center.z) * scale;

    // Deep sea, in the very tone the baked sheet paints it: beyond the sheet the map
    // is unseen water, under the same fog as the rest. A paler fill here used to
    // leave two seas meeting along the sheet's own edges — straight lines running
    // the height and width of the map.
    ctx.fillStyle = 'rgb(116, 191, 210)';
    ctx.fillRect(0, 0, w, h);

    // the finished sheet, and over it the one being painted (its unpainted rows are clear)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const sh of [baseRef.current, sheet]) {
      if (!sh) continue;
      const half = sh.span / 2;
      ctx.drawImage(sh.canvas, toX(sh.cx - half), toY(sh.cz - half), sh.span * scale, sh.span * scale);
    }

    // fog: ONE cloud field over the whole view, as far as the sea beneath it, with
    // the seen area punched out. The mask's own edge is the frontier and the
    // coastline, so no square of fog ever shows.
    if (fog) {
      if (!fogRef.current || fogRef.current.version !== fogVersion) {
        fogRef.current = { version: fogVersion, canvas: bakeFog(fog) };
      }
      const f = fogRef.current.canvas;
      const fSpan = (f as HTMLCanvasElement & { worldSpan?: number }).worldSpan ?? fogSpan;
      const mx = toX(-fSpan / 2);
      const my = toY(-fSpan / 2);
      const mw = fSpan * scale;
      const tileScale = Math.max(0.4, Math.min(2.2, scale * 0.6));
      const period = CLOUD_PX * tileScale;
      const layer = paintFogLayer(
        Math.round(w),
        Math.round(h),
        // drawn in MASK-SPACE, so destination-out samples its own soft alpha: seen
        // ground becomes transparent, everything else stays cloud
        (c) => {
          c.imageSmoothingEnabled = true;
          c.drawImage(f, mx, my, mw, mw);
        },
        // pinned to the world, so the cloud travels with the land when the sheet is dragged
        {
          tileScale,
          originX: (((toX(0)) % period) + period) % period,
          originY: (((toY(0)) % period) + period) % period,
          maskRect: { x: mx, y: my, w: mw, h: mw },
        },
      );
      ctx.drawImage(layer, 0, 0, w, h);
    }

    // the only mark on the sheet: the tile being opened right now
    if (grid?.gen) {
      const cell = TILE * scale;
      const sx = toX(grid.gen.x * TILE - TILE / 2);
      const sy = toY(grid.gen.z * TILE - TILE / 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.beginPath();
      ctx.roundRect(sx, sy, cell, cell, Math.min(14, cell * 0.12));
      ctx.fill();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)';
      ctx.stroke();
    }

    // player: drawn at its REAL world position — the map is a stable world sheet
    // you pan around, and the arrow travels across it with you
    ctx.save();
    ctx.translate(toX(px), toY(pz));
    const pad = ctx.createRadialGradient(0, 0, 2, 0, 0, 27);
    pad.addColorStop(0, 'rgba(255,255,255,0.82)');
    pad.addColorStop(0.66, 'rgba(255,255,255,0.26)');
    pad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(0, 0, 27, 0, Math.PI * 2);
    ctx.fillStyle = pad;
    ctx.fill();
    ctx.rotate(-yaw);
    drawPlayerArrow(ctx, 26);
    ctx.restore();
  }, [sheet, fog, fogSpan, fogVersion, center, zoom, px, pz, yaw, size, grid]);

  /** px per BU on screen at a zoom */
  const pxPerBu = (rect: { width: number; height: number }, z: number) => Math.min(rect.width, rect.height) / (BASE_ZOOM / z);

  /** one finger drags the sheet; two pinch to zoom, around the point between them */
  const track = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.current.values()];
    if (a && b) {
      gesture.current = null;
      pinch.current = { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cx: center.x, cz: center.z };
      return;
    }
    gesture.current = { x: e.clientX, y: e.clientY, cx: center.x, cz: center.z, moved: false };
    setDragging(true);
  };

  return (
    <div className="map-page">
      <div
        className={`map-sheet ${dragging ? 'dragging' : ''}`}
        ref={wrapRef}
        onPointerDown={(e) => {
          // never start a drag from a control — the sheet uses pointer capture,
          // which would swallow the button's click entirely
          if ((e.target as HTMLElement).closest('button')) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          track(e);
        }}
        onPointerMove={(e) => {
          const rect = wrapRef.current!.getBoundingClientRect();
          const scale = Math.min(rect.width, rect.height) / (BASE_ZOOM / zoom);
          if (pinch.current) {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const [a, b] = [...pointers.current.values()];
            const p = pinch.current;
            if (!a || !b || !p) return;
            const z = clamp(p.zoom * (Math.hypot(b.x - a.x, b.y - a.y) / p.dist), zoomMin, ZOOM_MAX);
            setZoom(z);
            // the world point that sat between the fingers when they came down stays
            // under the midpoint, however far apart they are now
            const was = pxPerBu(rect, p.zoom);
            const now = pxPerBu(rect, z);
            const wx = p.cx + (p.mx - rect.left - rect.width / 2) / was;
            const wz = p.cz + (p.my - rect.top - rect.height / 2) / was;
            setCenter(clampCenter({ x: wx - ((a.x + b.x) / 2 - rect.left - rect.width / 2) / now, z: wz - ((a.y + b.y) / 2 - rect.top - rect.height / 2) / now }, z));
            return;
          }
          const d = gesture.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved) setCenter(clampCenter({ x: d.cx - dx / scale, z: d.cz - dy / scale }, zoom));
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (pointers.current.size === 0) {
            gesture.current = null;
            setDragging(false);
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (pointers.current.size === 0) {
            gesture.current = null;
            setDragging(false);
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
          // around the pointer, not the middle of the screen: the world point under
          // it stays under it, so zooming in is aiming as well
          const rect = wrapRef.current!.getBoundingClientRect();
          const z = clamp(zoom * Math.exp(-e.deltaY * 0.0016), zoomMin, ZOOM_MAX);
          const was = pxPerBu(rect, zoom);
          const now = pxPerBu(rect, z);
          const ox = e.clientX - rect.left - rect.width / 2;
          const oy = e.clientY - rect.top - rect.height / 2;
          setZoom(z);
          setCenter((c) => clampCenter({ x: c.x + ox * (1 / was - 1 / now), z: c.z + oy * (1 / was - 1 / now) }, z));
        }}
      >
        <canvas ref={canvasRef} className="map-canvas" />
      </div>

      {/* the only chrome on the page: one close button, outside the drag surface */}
      <button className="close-btn map-close ctl" onClick={onClose} aria-label="关闭地图">
        <IconClose size={26} />
      </button>
    </div>
  );
}
