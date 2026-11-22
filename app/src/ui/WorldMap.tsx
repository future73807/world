import { useEffect, useRef, useState } from 'react';
import { bakeFog, bakeCloudTile, drawPlayerArrow, fillOutsideRect } from '../lib/mapArt';
import { renderMapRegion } from '../game/terrain';
import { IslandField } from '../game/world';
import { IconClose } from './icons';

/**
 * Map page. A stable world sheet you pan around: the blue arrow travels across
 * it at the player's REAL position, so the map always answers "where am I".
 * World coverage is unbounded: terrain is re-baked in tiles around the current
 * centre, so the sheet has no edge to run into.
 */

interface WorldMapProps {
  /** height field, used to bake terrain on demand */
  field: IslandField | null;
  fog: HTMLCanvasElement | null;
  /** world span the fog mask covers (it changes when the world grows) */
  fogSpan: number;
  fogVersion: number;
  px: number;
  pz: number;
  yaw: number;
  onClose: () => void;
}

const TILE_PX = 1024; // baked resolution of one map tile
const TILE_BU = 700; // world units one tile covers
const BASE_ZOOM = 118; // BU visible on screen at zoom 1
const TILE_STEP = 90; // re-bake once the view has drifted this far

interface Tile {
  cx: number;
  cz: number;
  canvas: HTMLCanvasElement;
}

/**
 * Full-screen map: unbounded pale cartographic terrain, the player arrow at its
 * true world position, and cloud fog over ground never walked. No scale bar, no
 * compass stack, no zoom chrome, no pins — a single close button.
 */
export function WorldMap({
  field, fog, fogSpan, fogVersion, px, pz, yaw, onClose,
}: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fogRef = useRef<{ version: number; canvas: HTMLCanvasElement } | null>(null);
  const tileRef = useRef<Tile | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [center, setCenter] = useState({ x: px, z: pz });
  const [size, setSize] = useState({ w: 1600, h: 900 });
  const [dragging, setDragging] = useState(false);
  const [tile, setTile] = useState<Tile | null>(null);
  const bakeTimer = useRef(0);
  const dragRef = useRef<{ x: number; y: number; cx: number; cz: number; moved: boolean } | null>(null);

  // The tile bakes lazily and DEFERRED: while you drag, the pending bake keeps
  // getting rescheduled, so the old tile stays on screen and panning never
  // stutters. The moment you pause, the fresh tile replaces it.
  // The tile is baked only when the view SETTLES. Re-baking during a drag
  // scheduled a huge height-field sweep on every pointer move, which blocked
  // the main thread and made the sheet stutter — the reported "拖动卡住".
  // "拖动卡住". While dragging we keep showing the existing tile, stretched.
  useEffect(() => {
    if (!field) return;
    if (dragging) return; // never bake mid-gesture
    const cur = tileRef.current;
    if (cur && Math.hypot(cur.cx - center.x, cur.cz - center.z) <= TILE_STEP) return;
    window.clearTimeout(bakeTimer.current);
    bakeTimer.current = window.setTimeout(() => {
      const cx = Math.round(center.x / 40) * 40;
      const cz = Math.round(center.z / 40) * 40;
      const canvas = renderMapRegion(field, TILE_PX, TILE_BU, cx, cz, true);
      const next: Tile = { cx, cz, canvas };
      tileRef.current = next;
      setTile(next);
    }, 120);
    return () => window.clearTimeout(bakeTimer.current);
  }, [field, center.x, center.z, fogVersion, dragging]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = size.w;
    const h = size.h;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const span = BASE_ZOOM / zoom; // BU across the shorter screen axis
    const scale = Math.min(w, h) / span;
    // the player is pinned to the centre: the map slides, the arrow does not
    const toX = (x: number) => w / 2 + (x - center.x) * scale;
    const toY = (z: number) => h / 2 + (z - center.z) * scale;

    // unbounded sea, so the sheet never shows a hard edge
    ctx.fillStyle = 'rgb(215, 236, 239)';
    ctx.fillRect(0, 0, w, h);

    if (tile) {
      const half = TILE_BU / 2;
      ctx.imageSmoothingEnabled = zoom < 2.6;
      ctx.drawImage(tile.canvas, toX(tile.cx - half), toY(tile.cz - half), TILE_BU * scale, TILE_BU * scale);
    }

    // fog, layer 1: cloud EVERYWHERE the mask cannot reach. The mask is a finite
    // square, and outside it there used to be no fog at all — unexplored terrain
    // showed through even though the sheet was mostly uncharted.
    // The mask rectangle is computed first so the cloud can be drawn outside it.
    let maskRect: { x: number; y: number; w: number } | null = null;
    if (fog) {
      if (!fogRef.current || fogRef.current.version !== fogVersion) {
        fogRef.current = { version: fogVersion, canvas: bakeFog(fog) };
      }
      const span = (fog as HTMLCanvasElement & { worldSpan?: number }).worldSpan ?? fogSpan;
      maskRect = { x: toX(-span / 2), y: toY(-span / 2), w: span * scale };
      const cloud = bakeCloudTile();
      const pat = ctx.createPattern(cloud, 'repeat');
      if (pat) {
        const tileScale = Math.max(0.4, Math.min(2.2, scale * 0.6));
        pat.setTransform?.(new DOMMatrix([tileScale, 0, 0, tileScale, 0, 0]));
        fillOutsideRect(ctx, w, h, maskRect.x, maskRect.y, maskRect.w, maskRect.w, pat);
        // a pale wash over the cloud keeps it consistent with the blurred mask
        fillOutsideRect(ctx, w, h, maskRect.x, maskRect.y, maskRect.w, maskRect.w, 'rgba(226, 241, 249, 0.5)');
      }
    }

    // fog, layer 2: the real mask on top, which carries the revealed holes
    if (fog && maskRect) {
      const f = fogRef.current!.canvas;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(f, maskRect.x, maskRect.y, maskRect.w, maskRect.w);
    }


    // player: drawn at its REAL world position — the map is a stable world
    // sheet you pan around, and the arrow travels across it with you
    const ax = toX(px);
    const ay = toY(pz);
    ctx.save();
    ctx.translate(ax, ay);
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
  }, [tile, fog, fogSpan, fogVersion, center, zoom, px, pz, yaw, size]);

  return (
    <div className="map-page">
      <div
        className={`map-sheet ${dragging ? 'dragging' : ''}`}
        ref={wrapRef}
        onPointerDown={(e) => {
          // never start a drag from a control — the sheet uses pointer capture,
          // which would swallow the button's click entirely
          if ((e.target as HTMLElement).closest('button')) return;
          dragRef.current = { x: e.clientX, y: e.clientY, cx: center.x, cz: center.z, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          const rect = wrapRef.current!.getBoundingClientRect();
          const scale = Math.min(rect.width, rect.height) / (BASE_ZOOM / zoom);
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved) setCenter({ x: d.cx - dx / scale, z: d.cz - dy / scale });
        }}
        onPointerUp={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onWheel={(e) => {
          e.preventDefault();
          setZoom((z) => Math.max(0.35, Math.min(4, z - e.deltaY * 0.0016)));
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
