import { useEffect, useRef } from 'react';
import { bakeFog, bakeCloudTile, drawPlayerArrow, fillOutsideRect } from '../lib/mapArt';

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
}

const DISC_BU = 76; // world units shown across the disc

/**
 * Circular minimap: the same height field the world uses, a baked white cloud
 * fog over unexplored ground, a soft rim, and the blue rounded player arrow
 * turning with the camera.
 */
export function Minimap({ size, source, explored, px, pz, yaw, fogVersion }: MinimapProps) {
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


    // circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();

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

      // The mask is a finite square. Cloud fills the disc wherever the mask has
      // no data, so bare unexplored terrain can never show through at the rim.
      if (explored) {
        if (!fogRef.current || fogRef.current.version !== fogVersion) {
          fogRef.current = { version: fogVersion, canvas: bakeFog(explored) };
        }
        const fog = fogRef.current.canvas;
        const fogSpan = (explored as HTMLCanvasElement & { worldSpan?: number }).worldSpan ?? 300;
        const r = rectOf(fogSpan);
        const tile = bakeCloudTile();
        const pat = ctx.createPattern(tile, 'repeat');
        if (pat) {
          const s = size / 260;
          pat.setTransform?.(new DOMMatrix([s, 0, 0, s, 0, 0]));
          fillOutsideRect(ctx, size, size, r.x, r.y, r.w, r.w, pat);
          fillOutsideRect(ctx, size, size, r.x, r.y, r.w, r.w, 'rgba(226, 241, 249, 0.42)');
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fog, r.x, r.y, r.w, r.w);
      } else {
        ctx.fillStyle = 'rgba(232, 242, 246, 0.96)';
        ctx.fillRect(0, 0, size, size);
      }
    } else {
      ctx.fillStyle = 'rgba(232, 242, 246, 0.96)';
      ctx.fillRect(0, 0, size, size);
    }

    // rim shade: keeps the disc from looking like a hard crop
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.42, size / 2, size / 2, size * 0.54);
    grad.addColorStop(0, 'rgba(47, 92, 110, 0)');
    grad.addColorStop(1, 'rgba(47, 92, 110, 0.16)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // player: one blue rounded arrow, screen-up = facing direction
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-yaw);
    drawPlayerArrow(ctx, 23);
    ctx.restore();
  }, [size, source, explored, px, pz, yaw, fogVersion]);

  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

export { DISC_BU };
