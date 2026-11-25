import { useEffect, useRef } from 'react';
import { bakeFog, drawPlayerArrow, paintFogLayer, raggedRim } from '../lib/mapArt';
import { TILE } from '../game/world';
import type { TileGrid } from './Hud';

interface MinimapProps {
  size: number;
  /** base terrain snapshot */
  source: HTMLCanvasElement | null;
  /** fog-of-war overlay: opaque mist outside explored areas */
  explored: HTMLCanvasElement | null;
  px: number;
  pz: number;
  yaw: number;
  /** regenerates the fog sprite; bump it when the mask changes */
  fogVersion: number;
  /** the tile E would open, and the one being generated */
  grid?: TileGrid;
}

const DISC_BU = 76; // world units shown from the centre to the rim
const CLOUD_PX = 256; // edge of the seamless cloud tile, before scaling

/**
 * Circular minimap: the same height field the world uses, cloud fog over ground
 * not yet seen, and the blue rounded player arrow turning with the camera. Its rim
 * is frayed like dry brushwork rather than faded to a circle, and nothing on it
 * speaks of tiles — only the one tile E would open is lightly outlined, so aiming
 * still has an answer on the map.
 */
export function Minimap({ size, source, explored, px, pz, yaw, fogVersion, grid }: MinimapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fogRef = useRef<{ version: number; canvas: HTMLCanvasElement } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // one scale for everything: px per world BU at this disc zoom
    const discBu = DISC_BU * 2;
    const scalePx = size / discBu;

    /** Screen rect of a world-span square centred on the world origin. */
    const rectOf = (spanBu: number) => ({
      x: size / 2 - px * scalePx + (-spanBu / 2) * scalePx,
      y: size / 2 - pz * scalePx + (-spanBu / 2) * scalePx,
      w: spanBu * scalePx,
    });

    if (source) {
      const worldSpan = (source as HTMLCanvasElement & { worldSpan?: number }).worldSpan ?? 300;
      const srcSpan = source.width;
      const sw = (discBu / worldSpan) * srcSpan;
      const sx = srcSpan / 2 + (px / worldSpan) * srcSpan - sw / 2;
      const sy = srcSpan / 2 + (pz / worldSpan) * srcSpan - sw / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(source, sx, sy, sw, sw, 0, 0, size, size);

      // Fog: ONE cloud field across the whole disc with the seen area punched out,
      // so the mist ends on coastlines and never on the edge of a square.
      if (explored) {
        if (!fogRef.current || fogRef.current.version !== fogVersion) {
          fogRef.current = { version: fogVersion, canvas: bakeFog(explored) };
        }
        const fog = fogRef.current.canvas;
        const fogSpan = (fog as HTMLCanvasElement & { worldSpan?: number }).worldSpan ?? 300;
        const r = rectOf(fogSpan);
        const tileScale = size / 250;
        const period = CLOUD_PX * tileScale;
        const layer = paintFogLayer(
          Math.round(size),
          Math.round(size),
          (c) => {
            c.imageSmoothingEnabled = true;
            c.drawImage(fog, r.x, r.y, r.w, r.w);
          },
          // pinned to the world: the cloud travels with the map under the arrow
          {
            tileScale,
            originX: (((size / 2 - px * scalePx) % period) + period) % period,
            originY: (((size / 2 - pz * scalePx) % period) + period) % period,
            maskRect: { x: r.x, y: r.y, w: r.w, h: r.w },
          },
        );
        ctx.drawImage(layer, 0, 0, size, size);
      } else {
        ctx.fillStyle = 'rgba(232, 242, 246, 0.96)';
        ctx.fillRect(0, 0, size, size);
      }
    } else {
      ctx.fillStyle = 'rgba(232, 242, 246, 0.96)';
      ctx.fillRect(0, 0, size, size);
    }

    // only the tile E would open (and the one being opened) is marked: a soft
    // dashed outline, nothing that lays a grid over the land
    const aimed = grid?.frontier.find((f) => f.open);
    const mark = aimed ?? grid?.gen;
    if (mark) {
      const tx = (v: number) => size / 2 + (v - px) * scalePx;
      const tz = (v: number) => size / 2 + (v - pz) * scalePx;
      const w = TILE * scalePx;
      const sx = tx(mark.x * TILE - TILE / 2);
      const sy = tz(mark.z * TILE - TILE / 2);
      const r = Math.min(10, w * 0.16);
      ctx.beginPath();
      ctx.roundRect(sx, sy, w, w, r);
      if (grid?.gen) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
        ctx.fill();
      }
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -performance.now() / 90; // the outline slowly walks round the tile
      ctx.lineWidth = grid?.gen ? 2.4 : 1.7;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // player: one blue rounded arrow, screen-up = facing direction
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-yaw);
    drawPlayerArrow(ctx, 23);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // the rim: everything outside a frayed, brush-drawn edge is wiped away
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(raggedRim(size), 0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
  }, [size, source, explored, px, pz, yaw, fogVersion, grid]);

  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

export { DISC_BU };
