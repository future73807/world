/**
 * Fog of war on the maps: what opening a tile lets the player see of it.
 *
 * The mist on the map ends where the opened land ends — never on the straight
 * line of a tile border. Opening a tile reveals its dry ground and the water a
 * few paces around it, and the edge of that area wanders a few BU either way with
 * the noise of the land, so the map reads as a coastline under cloud and not as a
 * grid of squares.
 */
import { IslandField, TILE, tileKey, tileOf } from './world';

/** how far from the shore the map still shows the water (BU) */
const SHORE_HALO = 12;
/** the cloud over the frontier breaks up between these two distances in from the tile border (BU) */
const FRINGE_MIN = 2;
const FRINGE_SPAN = 7;
/** how far the ragged edge of the shore halo wanders either way (BU) */
const RAG = 6.5;
/** strip around the tile that has to be looked at to find the shore and the neighbours (BU) */
const MARGIN = 24;
/** one cell of the reveal grid (BU) */
const CELL = 1;
const INF = 1e9;
const DIAG = Math.SQRT2;

interface Square {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const distToSquare = (x: number, z: number, s: Square) => Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.z0 - z, 0, z - s.z1));

let sheet: HTMLCanvasElement | null = null;

/**
 * Clears the mist over a tile on the fog mask `ctx` draws on (a `size` px square
 * covering `span` BU, centred on the world origin): alpha is taken away where the
 * tile is now visible.
 */
export function revealTile(field: IslandField, tile: { x: number; z: number }, ctx: CanvasRenderingContext2D, span: number, size: number): void {
  const x0 = tile.x * TILE - TILE / 2 - MARGIN;
  const z0 = tile.z * TILE - TILE / 2 - MARGIN;
  const n = Math.round((TILE + MARGIN * 2) / CELL);
  const total = n * n;
  const opened = new Uint8Array(total);
  const land = new Uint8Array(total);
  // distance (BU) from each cell to the nearest opened dry ground
  const shore = new Float32Array(total);

  // the tiles in and around the strip, with the unopened squares each one borders
  const tx0 = tileOf(x0, z0)[0];
  const tz0 = tileOf(x0, z0)[1];
  const tx1 = tileOf(x0 + n * CELL, z0 + n * CELL)[0];
  const tz1 = tileOf(x0 + n * CELL, z0 + n * CELL)[1];
  const beyond = new Map<number, Square[]>();
  const squareOf = (x: number, z: number): Square => ({ x0: x * TILE - TILE / 2, z0: z * TILE - TILE / 2, x1: x * TILE + TILE / 2, z1: z * TILE + TILE / 2 });
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!field.get(tx, tz)) continue;
      const list: Square[] = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dz) && !field.get(tx + dx, tz + dz)) list.push(squareOf(tx + dx, tz + dz));
        }
      }
      beyond.set(tileKey(tx, tz), list);
    }
  }

  for (let j = 0; j < n; j++) {
    const z = z0 + (j + 0.5) * CELL;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + (i + 0.5) * CELL;
      const [tx, tz] = tileOf(x, z);
      if (!field.get(tx, tz)) {
        shore[k] = INF;
        continue;
      }
      opened[k] = 1;
      // the floor of an unopened tile is sea, so this is the ground only where it is open
      if (field.height(x, z) >= 0.05) land[k] = 1;
      else shore[k] = INF;
    }
  }

  // distance to the nearest dry cell: two sweeps of a chamfer transform
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!shore[k]) continue;
      let d = shore[k];
      if (i > 0) d = Math.min(d, shore[k - 1] + 1);
      if (j > 0) {
        d = Math.min(d, shore[k - n] + 1);
        if (i > 0) d = Math.min(d, shore[k - n - 1] + DIAG);
        if (i < n - 1) d = Math.min(d, shore[k - n + 1] + DIAG);
      }
      shore[k] = d;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let d = shore[k];
      if (i < n - 1) d = Math.min(d, shore[k + 1] + 1);
      if (j < n - 1) {
        d = Math.min(d, shore[k + n] + 1);
        if (i < n - 1) d = Math.min(d, shore[k + n + 1] + DIAG);
        if (i > 0) d = Math.min(d, shore[k + n - 1] + DIAG);
      }
      shore[k] = d;
    }
  }

  if (!sheet) sheet = document.createElement('canvas');
  sheet.width = n;
  sheet.height = n;
  const sctx = sheet.getContext('2d')!;
  const img = sctx.createImageData(n, n);
  for (let j = 0; j < n; j++) {
    const z = z0 + (j + 0.5) * CELL;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!opened[k]) continue;
      const x = x0 + (i + 0.5) * CELL;
      // how far in from the frontier the cloud breaks here: never right on the
      // border, or a straight edge of tile would show wherever the noise ran low
      const e = field.edgeNoise(x, z);
      const fringe = FRINGE_MIN + FRINGE_SPAN * (0.5 + 0.5 * e);
      const [tx, tz] = tileOf(x, z);
      let d = INF;
      for (const s of beyond.get(tileKey(tx, tz)) ?? []) d = Math.min(d, distToSquare(x, z, s));
      if (d <= fringe) continue;
      // dry ground is seen; water for a little way out from the shore, less where
      // the cloud hangs low
      if (land[k] || shore[k] < SHORE_HALO + e * RAG) img.data[k * 4 + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);

  const toPx = (v: number) => (v / span + 0.5) * size;
  const w = ((n * CELL) / span) * size;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sheet, toPx(x0), toPx(z0), w, w);
  ctx.restore();
}
