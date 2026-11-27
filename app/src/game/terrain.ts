import * as THREE from 'three';
import { IslandField, CHUNK, SUBDIV, SEA, tileBounds, TileState } from './world';
import { PAL } from './palette';
import type { BiomeWeights } from './biomes';
import { Perlin2, smoothstep, lerp, hash01, clamp01, mulberry32 } from '../lib/noise';

const tmpColor = new Float32Array(3);

export const WORLD_SPAN = 300; // world-space span the boot minimap canvas covers

/** Deterministic XY jitter keyed by integer grid coords so chunk seams still match. */
function jitter(ix: number, iz: number): [number, number] {
  return [(hash01(ix, iz) - 0.5) * 0.08, (hash01(iz + 41.7, ix - 13.3) - 0.5) * 0.08];
}

/**
 * One chunk mesh: indexed shared-vertex grid, analytic normals, biome vertex colours.
 * Heights are sampled once on a grid with a one-cell margin so every normal comes from
 * neighbouring samples — a fifth of the height() calls of the per-vertex version.
 */
export function buildChunkMesh(field: IslandField, cx: number, cz: number): THREE.BufferGeometry {
  const step = CHUNK / SUBDIV;
  const row = SUBDIV + 1;
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  const n = SUBDIV + 3;
  const hs = new Float32Array(n * n);
  for (let j = -1; j <= SUBDIV + 1; j++) {
    for (let i = -1; i <= SUBDIV + 1; i++) {
      const [jx, jz] = jitter(cx * SUBDIV + i, cz * SUBDIV + j);
      hs[(j + 1) * n + (i + 1)] = field.height(ox + i * step + jx, oz + j * step + jz);
    }
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= SUBDIV; j++) {
    for (let i = 0; i <= SUBDIV; i++) {
      const [jx, jz] = jitter(cx * SUBDIV + i, cz * SUBDIV + j);
      const x = ox + i * step + jx;
      const z = oz + j * step + jz;
      const h = hs[(j + 1) * n + (i + 1)];
      const hx = hs[(j + 1) * n + (i + 2)] - hs[(j + 1) * n + i];
      const hz = hs[(j + 2) * n + (i + 1)] - hs[j * n + (i + 1)];
      const nx = -hx;
      const nz = -hz;
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz) || 1;
      positions.push(x, h, z);
      normals.push(nx / len, ny / len, nz / len);
      field.groundColor(x, z, h, ny / len, tmpColor);
      // a whisper of per-sample tone so large facets never read as one flat fill
      const k = 1 + (hash01(cx * SUBDIV + i + 7.3, cz * SUBDIV + j - 2.1) - 0.5) * 0.06;
      colors.push(tmpColor[0] * k, tmpColor[1] * k, tmpColor[2] * k);
    }
  }

  for (let j = 0; j < SUBDIV; j++) {
    for (let i = 0; i < SUBDIV; i++) {
      const a = j * row + i;
      const b = a + 1;
      const d = a + row;
      const c = d + 1;
      if ((cx + cz + i + j) % 2 === 0) {
        indices.push(a, c, b, a, d, c);
      } else {
        indices.push(a, d, b, b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * True when a chunk is nothing but deep OPEN sea — the water plane already covers
 * it, so there is no point building a mesh. The ring around the chunk must be
 * deep as well: an inland lake is deep too, but skipping its bottom left a
 * square hole in the ground.
 */
export function isDeepSea(field: IslandField, cx: number, cz: number): boolean {
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      if (field.height(ox + (i / 4) * CHUNK, oz + (j / 4) * CHUNK) > -4.2) return false;
    }
  }
  for (let k = -6; k <= CHUNK + 6; k += 4) {
    if (field.height(ox + k, oz - 6) > -1 || field.height(ox + k, oz + CHUNK + 6) > -1) return false;
    if (field.height(ox - 6, oz + k) > -1 || field.height(ox + CHUNK + 6, oz + k) > -1) return false;
  }
  return true;
}

/** Chunk range covering every generated tile plus `margin` chunks. */
export function chunkRange(tiles: TileState[], margin = 1): { x0: number; x1: number; z0: number; z1: number } {
  const b = tileBounds(tiles, margin * CHUNK);
  return { x0: Math.floor(b.minX / CHUNK), x1: Math.floor(b.maxX / CHUNK), z0: Math.floor(b.minZ / CHUNK), z1: Math.floor(b.maxZ / CHUNK) };
}

/** Chunked terrain: chunks are built on demand so new regions can extend the world. */
export class TerrainChunks {
  readonly group = new THREE.Group();
  private chunks = new Map<number, THREE.Mesh>();
  /** chunks whose geometry came from the Blender terrain export (not built in the browser) */
  private imported = new Set<number>();
  private mat: THREE.MeshStandardMaterial;
  triangleCount = 0;
  /** meshes touched by the last buildRange, so callers can fog-reveal them */
  readonly lastBuilt: THREE.Mesh[] = [];

  private field: IslandField;

  constructor(field: IslandField) {
    this.field = field;
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    this.group.name = 'Terrain_Chunks';
  }

  has(cx: number, cz: number): boolean {
    return this.chunks.has((cx + 512) * 4096 + (cz + 512));
  }

  isImported(cx: number, cz: number): boolean {
    return this.imported.has((cx + 512) * 4096 + (cz + 512));
  }

  /**
   * Installs a chunk mesh that Blender exported. The browser draws it as-is; the
   * heights that go with it are registered on the field by the caller.
   */
  useImported(cx: number, cz: number, geometry: THREE.BufferGeometry) {
    const key = (cx + 512) * 4096 + (cz + 512);
    const existing = this.chunks.get(key);
    if (existing) {
      this.triangleCount -= (existing.geometry.getIndex()?.count ?? 0) / 3;
      existing.geometry.dispose();
      this.group.remove(existing);
    }
    const geo = new THREE.BufferGeometry();
    const pos = geometry.getAttribute('position');
    geo.setAttribute('position', new THREE.BufferAttribute(pos.array as Float32Array, 3));
    const col = geometry.getAttribute('color');
    if (col) geo.setAttribute('color', toRgb(col));
    geo.setIndex(geometry.index ? geometry.index : null);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    mesh.name = `Chunk_${cx}_${cz}`;
    this.chunks.set(key, mesh);
    this.imported.add(key);
    this.group.add(mesh);
    this.triangleCount += (geo.getIndex()?.count ?? 0) / 3;
  }

  /**
   * Builds (or REBUILDS) one chunk in the browser. A rebuild discards a Blender-exported
   * mesh for that chunk: new terrain has raised the ground under it, so the old surface
   * is stale.
   */
  buildChunk(cx: number, cz: number, force = false): boolean {
    const key = (cx + 512) * 4096 + (cz + 512);
    const existing = this.chunks.get(key);
    if (existing) {
      if (!force) return false;
      this.triangleCount -= (existing.geometry.getIndex()?.count ?? 0) / 3;
      existing.geometry.dispose();
      this.group.remove(existing);
      this.chunks.delete(key);
    }
    this.imported.delete(key);
    const geo = buildChunkMesh(this.field, cx, cz);
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    mesh.name = `Chunk_${cx}_${cz}`;
    this.chunks.set(key, mesh);
    this.group.add(mesh);
    this.triangleCount += (geo.getIndex()?.count ?? 0) / 3;
    return true;
  }

  /** Builds every not-yet-built land or shelf chunk in a range. Returns the new meshes. */
  buildRange(field: IslandField, r: { x0: number; x1: number; z0: number; z1: number }): THREE.Mesh[] {
    this.field = field;
    const out: THREE.Mesh[] = [];
    for (let j = r.z0; j <= r.z1; j++) {
      for (let i = r.x0; i <= r.x1; i++) {
        if (this.has(i, j)) continue;
        if (isDeepSea(field, i, j)) continue;
        this.buildChunk(i, j);
        out.push(this.chunks.get((i + 512) * 4096 + (j + 512))!);
      }
    }
    return out;
  }

  /** Force-rebuilds existing chunks in a range (their ground changed). */
  rebuildRange(r: { x0: number; x1: number; z0: number; z1: number }): number {
    let n = 0;
    for (let j = r.z0; j <= r.z1; j++) {
      for (let i = r.x0; i <= r.x1; i++) {
        if (this.has(i, j)) {
          this.buildChunk(i, j, true);
          n++;
        }
      }
    }
    return n;
  }

  disposeAll() {
    for (const m of this.chunks.values()) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.chunks.clear();
    this.imported.clear();
    this.triangleCount = 0;
  }

  get count() {
    return this.chunks.size;
  }
}

/** GLB colour attribute -> float rgb (getX() denormalises normalised integers itself). */
function toRgb(src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const col = src as THREE.BufferAttribute;
  const out = new Float32Array(col.count * 3);
  for (let i = 0; i < col.count; i++) {
    out[i * 3] = col.getX(i);
    out[i * 3 + 1] = col.getY(i);
    out[i * 3 + 2] = col.getZ(i);
  }
  return new THREE.BufferAttribute(out, 3);
}

export function terrainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
}

// --------------------------------------------------------------------------- coastline

export interface CoastLoop {
  /** shoreline points, closed (last === first); walking them keeps the land on the LEFT */
  pts: THREE.Vector2[];
  /** signed area in the (x, z) plane */
  area: number;
  length: number;
  /** 1 where the water side leads to open sea, 0 for lakes, ponds and enclosed straits */
  open: Uint8Array;
}

/**
 * Coastline as closed loops (marching squares on the height field at sea level).
 * Unlike ray casting from an origin this works for any land shape: bays, straits,
 * separate islets and inland lakes.
 */
export function traceCoastLoops(field: IslandField, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, step = 1): CoastLoop[] {
  const W = Math.ceil((bounds.maxX - bounds.minX) / step) + 1;
  const H = Math.ceil((bounds.maxZ - bounds.minZ) / step) + 1;
  const hs = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) hs[j * W + i] = field.height(bounds.minX + i * step, bounds.minZ + j * step);
  }
  const CW = W - 1;
  const CH = H - 1;
  const leftBase = CW * CH;
  const edgeCount = leftBase + W * CH;
  // next[e] = the edge a contour continues to, walking with the land on the left
  const next = new Int32Array(edgeCount).fill(-1);
  const bottom = (i: number, j: number) => j * CW + i;
  const left = (i: number, j: number) => leftBase + j * W + i;

  for (let j = 0; j < CH; j++) {
    for (let i = 0; i < CW; i++) {
      const h00 = hs[j * W + i];
      const h10 = hs[j * W + i + 1];
      const h11 = hs[(j + 1) * W + i + 1];
      const h01 = hs[(j + 1) * W + i];
      const c = (h00 > SEA ? 1 : 0) | (h10 > SEA ? 2 : 0) | (h11 > SEA ? 4 : 0) | (h01 > SEA ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const b = bottom(i, j);
      const t = bottom(i, j + 1);
      const l = left(i, j);
      const r = left(i + 1, j);
      const link = (from: number, to: number) => {
        next[from] = to;
      };
      // Cases (bit = corner is land): a=P00 1, b=P10 2, c=P11 4, d=P01 8. Every link
      // walks the contour with the LAND ON ITS LEFT (x right, z up), so the right-hand
      // normal of a loop always points at the water. Cases 9 / 10 are NOT saddles:
      // 9 = left half land, 10 = the b+d saddle.
      switch (c) {
        case 1: // only a
          link(b, l);
          break;
        case 14: // all but a
          link(l, b);
          break;
        case 8: // only d
          link(l, t);
          break;
        case 7: // all but d
          link(t, l);
          break;
        case 4: // only c
          link(t, r);
          break;
        case 11: // all but c
          link(r, t);
          break;
        case 2: // only b
          link(r, b);
          break;
        case 13: // all but b
          link(b, r);
          break;
        case 3: // a + b: lower half is land
          link(r, l);
          break;
        case 12: // c + d: upper half is land
          link(l, r);
          break;
        case 6: // b + c: right half is land
          link(t, b);
          break;
        case 9: // d + a: left half is land
          link(b, t);
          break;
        case 5: // saddle a + c
          link(b, l);
          link(t, r);
          break;
        case 10: // saddle b + d
          link(r, b);
          link(l, t);
          break;
      }
    }
  }

  const crossing = (e: number, out: THREE.Vector2) => {
    if (e < leftBase) {
      const j = Math.floor(e / CW);
      const i = e - j * CW;
      const h0 = hs[j * W + i];
      const h1 = hs[j * W + i + 1];
      out.set(bounds.minX + (i + clamp01((SEA - h0) / (h1 - h0 || 1e-6))) * step, bounds.minZ + j * step);
    } else {
      const k = e - leftBase;
      const j = Math.floor(k / W);
      const i = k - j * W;
      const h0 = hs[j * W + i];
      const h1 = hs[(j + 1) * W + i];
      out.set(bounds.minX + i * step, bounds.minZ + (j + clamp01((SEA - h0) / (h1 - h0 || 1e-6))) * step);
    }
    return out;
  };

  const seen = new Uint8Array(edgeCount);
  const loops: CoastLoop[] = [];
  const p = new THREE.Vector2();
  const SIMPLIFY = 0.55;
  for (let e0 = 0; e0 < edgeCount; e0++) {
    if (next[e0] < 0 || seen[e0]) continue;
    const pts: THREE.Vector2[] = [];
    let e = e0;
    let guard = 0;
    let area = 0;
    let length = 0;
    let last: THREE.Vector2 | null = null;
    let first: THREE.Vector2 | null = null;
    let prevRaw: THREE.Vector2 | null = null;
    do {
      seen[e] = 1;
      crossing(e, p);
      const cur = p.clone();
      if (first === null) first = cur.clone();
      if (prevRaw) {
        area += prevRaw.x * cur.y - cur.x * prevRaw.y;
        length += prevRaw.distanceTo(cur);
      }
      prevRaw = cur;
      if (!last || last.distanceToSquared(cur) > SIMPLIFY * SIMPLIFY) {
        pts.push(cur);
        last = cur;
      }
      e = next[e];
    } while (e !== e0 && next[e] >= 0 && ++guard < edgeCount);
    if (pts.length >= 3) {
      // close the loop with the true first point
      pts.push(first!);
      const loop: CoastLoop = { pts: smoothLoop(pts, 1.5), area: area * 0.5, length, open: new Uint8Array(0) };
      loop.open = new Uint8Array(loop.pts.length);
      // The table above should already keep land on the left. Trust the ground, not
      // the derivation: probe the water side, and reverse the loop if it is dry.
      const at = Math.floor(pts.length / 2);
      const o = coastOutward(loop, at, new THREE.Vector2());
      const mid = pts[at];
      if (field.height(mid.x + o.x * 2.5, mid.y + o.y * 2.5) > SEA) {
        loop.pts = pts.slice().reverse();
        loop.area = -loop.area;
      }
      loops.push(loop);
    }
  }
  markOpenWater(field, loops);
  return loops;
}

/**
 * A contour traced on a 1 BU grid is a staircase: its point normals swing about
 * 45° from one vertex to the next, which drew the foam as a sawtooth. Smooth the
 * polyline with a few binomial passes, then resample it at an even spacing.
 */
function smoothLoop(raw: THREE.Vector2[], spacing: number): THREE.Vector2[] {
  let pts = raw.slice(0, -1); // drop the closing duplicate while filtering
  const n = pts.length;
  if (n < 4) return raw;
  for (let pass = 0; pass < 3; pass++) {
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      return new THREE.Vector2((a.x + 2 * p.x + b.x) * 0.25, (a.y + 2 * p.y + b.y) * 0.25);
    });
  }
  const out: THREE.Vector2[] = [pts[0].clone()];
  // resample by arc length: a sample every `spacing` BU along the smoothed line
  let nextAt = spacing;
  let travelled = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const seg = p.distanceTo(q);
    if (seg < 1e-6) continue;
    while (nextAt <= travelled + seg) {
      const t = (nextAt - travelled) / seg;
      out.push(new THREE.Vector2(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t));
      nextAt += spacing;
    }
    travelled += seg;
  }
  if (out.length > 2 && out[out.length - 1].distanceTo(out[0]) < spacing * 0.5) out.pop();
  out.push(out[0].clone());
  return out;
}

/** Unit vector pointing from the shoreline toward the water side of a loop. */
export function coastOutward(loop: CoastLoop, i: number, out: THREE.Vector2): THREE.Vector2 {
  const pts = loop.pts;
  const n = pts.length - 1;
  const a = pts[(i - 1 + n) % n];
  const b = pts[(i + 1) % n];
  out.set(b.y - a.y, -(b.x - a.x));
  return out.normalize();
}

/**
 * Marks where a shoreline faces open water: march outward from every few points;
 * if the march reaches dry land again the water is enclosed (a lake, a pond, a
 * strait between two known shores) and no cliff skirt or frontier mist goes there.
 */
export function markOpenWater(field: IslandField, loops: CoastLoop[]): void {
  const o = new THREE.Vector2();
  for (const loop of loops) {
    const n = loop.pts.length - 1;
    loop.open.fill(1);
    for (let i = 0; i < n; i += 3) {
      coastOutward(loop, i, o);
      const p = loop.pts[i];
      let enclosed = false;
      for (let d = 3; d <= 64; d += 2.5) {
        if (field.height(p.x + o.x * d, p.y + o.y * d) > 0.3) {
          enclosed = true;
          break;
        }
      }
      if (enclosed) for (let k = -3; k <= 3; k++) loop.open[(i + k + n) % n] = 0;
    }
  }
}

const STRATA = [PAL.sandWet, PAL.sandDeep, 0xa48f6d, 0x8e7c63, 0x7a6d5b, 0x6a6357, 0x5b5f5c, 0x4e5658, 0x454e53, 0x3d454a];

/**
 * Cliff skirt: from the shoreline down and inward in strata, so the island reads as a
 * cut block of earth floating in the sea rather than a sheet of ground on water.
 */
export function buildCliff(loops: CoastLoop[], seed: number, maxSegments = 2600): THREE.Mesh | null {
  if (!loops.length) return null;
  const n = new Perlin2(seed + 71);
  const bands = [
    { drop: 0.3, inset: 0.0 },
    { drop: 0.95, inset: 0.12 },
    { drop: 1.9, inset: 0.4 },
    { drop: 3.1, inset: 0.9 },
    { drop: 4.6, inset: 1.7 },
    { drop: 6.4, inset: 2.7 },
    { drop: 8.6, inset: 4.0 },
    { drop: 11.2, inset: 5.6 },
    { drop: 14.2, inset: 7.6 },
    { drop: 17.4, inset: 10.2 },
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const dir = new THREE.Vector2();
  const shadeA = new THREE.Color();
  const shadeB = new THREE.Color();
  const mix = new THREE.Color();
  let budget = maxSegments;
  for (const loop of loops) {
    if (budget <= 0) break;
    const pts = loop.pts;
    const m = pts.length - 1;
    // step along the loop so long coastlines stay inside the triangle budget,
    // and keep only the stretches that face open water
    const stride = Math.max(1, Math.ceil(m / budget));
    const idx: number[] = [];
    for (let i = 0; i < m; i += stride) if (loop.open[i]) idx.push(i);
    budget -= idx.length;
    if (idx.length < 3) continue;
    const rings: THREE.Vector3[][] = bands.map((b, bi) =>
      idx.map((i) => {
        const p = pts[i];
        coastOutward(loop, i, dir);
        const wob = n.noise(dir.x * 2.2 + bi * 0.7, dir.y * 2.2 - bi * 0.4) * 0.9;
        const r = b.inset * 1 - wob * Math.min(1, b.inset * 0.35 + 0.15);
        const x = p.x - dir.x * r;
        const z = p.y - dir.y * r;
        const ripple = n.noise(x * 0.4, z * 0.4 + bi * 1.7) * 0.28;
        return new THREE.Vector3(x, -b.drop + ripple, z);
      }),
    );
    const L = idx.length;
    for (let b = 0; b < rings.length - 1; b++) {
      shadeA.setHex(STRATA[b]);
      shadeB.setHex(STRATA[b + 1]);
      mix.lerpColors(shadeA, shadeB, 0.5);
      for (let i = 0; i < L; i++) {
        const i2 = (i + 1) % L;
        // never bridge a stretch that was cut out of the mask (a bay, an inlet)
        const gap = i2 === 0 ? m - idx[i] + idx[0] : idx[i2] - idx[i];
        if (gap > stride) continue;
        const a = rings[b][i];
        const bb = rings[b][i2];
        const c = rings[b + 1][i2];
        const d = rings[b + 1][i];
        pos.push(a.x, a.y, a.z, bb.x, bb.y, bb.z, c.x, c.y, c.z);
        pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
        for (let k = 0; k < 6; k++) col.push(mix.r, mix.g, mix.b);
      }
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Terrain_Cliff';
  return mesh;
}

/** A disc of molten rock that sits in a volcano crater and glows. */
export function buildLavaPool(pool: { x: number; z: number; y: number; r: number }): THREE.Mesh {
  const geo = new THREE.CircleGeometry(pool.r, 28);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff5a14,
    emissive: 0xff7a1f,
    emissiveIntensity: 1.6,
    roughness: 0.5,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pool.x, pool.y, pool.z);
  mesh.name = 'Lava_Pool';
  return mesh;
}

// --------------------------------------------------------------------------- map

export interface MapPainter {
  /** the sheet being painted: what is done so far is already on it */
  canvas: HTMLCanvasElement;
  /** paints up to `rows` more rows (then the line work); true once the whole sheet is done */
  step(rows: number): boolean;
  /** puts the last rows on the canvas; returns the sheet */
  finish(): HTMLCanvasElement;
}

/** height lines every this many BU on land; every fifth is drawn heavier */
const CONTOUR_STEP = 2;
const CONTOUR_TOP = 30;
/** height lines under water, in BU of depth */
const DEPTH_LINES = [-2, -4, -6, -8];
/** where the map calls it the shore: below this the ground counts as water */
const MAP_SHORE = 0.2;

/**
 * One height line of the sheet, followed cell by cell (marching squares) and
 * added to the current path as short, exactly placed segments.
 */
function traceLevel(ctx: CanvasRenderingContext2D, heights: Float32Array, size: number, level: number): void {
  for (let j = 0; j < size - 1; j++) {
    const r0 = j * size;
    const r1 = r0 + size;
    for (let i = 0; i < size - 1; i++) {
      const a = heights[r0 + i];
      const b = heights[r0 + i + 1];
      const c = heights[r1 + i];
      const d = heights[r1 + i + 1];
      if (a > level && b > level && c > level && d > level) continue;
      if (a < level && b < level && c < level && d < level) continue;
      const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (d > level ? 4 : 0) | (c > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // the four edge crossings of the cell: top, right, bottom, left
      const top = i + (level - a) / (b - a || 1e-9);
      const right = j + (level - b) / (d - b || 1e-9);
      const bottom = i + (level - c) / (d - c || 1e-9);
      const left = j + (level - a) / (c - a || 1e-9);
      const X0 = i;
      const X1 = i + 1;
      const Y0 = j;
      const Y1 = j + 1;
      switch (code) {
        case 1:
        case 14:
          ctx.moveTo(X0, left);
          ctx.lineTo(top, Y0);
          break;
        case 2:
        case 13:
          ctx.moveTo(top, Y0);
          ctx.lineTo(X1, right);
          break;
        case 3:
        case 12:
          ctx.moveTo(X0, left);
          ctx.lineTo(X1, right);
          break;
        case 4:
        case 11:
          ctx.moveTo(X1, right);
          ctx.lineTo(bottom, Y1);
          break;
        case 6:
        case 9:
          ctx.moveTo(top, Y0);
          ctx.lineTo(bottom, Y1);
          break;
        case 7:
        case 8:
          ctx.moveTo(X0, left);
          ctx.lineTo(bottom, Y1);
          break;
        case 5: // a and d: which way round depends on the middle
          if ((a + b + c + d) / 4 > level) {
            ctx.moveTo(X0, left);
            ctx.lineTo(bottom, Y1);
            ctx.moveTo(top, Y0);
            ctx.lineTo(X1, right);
          } else {
            ctx.moveTo(X0, left);
            ctx.lineTo(top, Y0);
            ctx.moveTo(X1, right);
            ctx.lineTo(bottom, Y1);
          }
          break;
        case 10:
          if ((a + b + c + d) / 4 > level) {
            ctx.moveTo(X0, left);
            ctx.lineTo(top, Y0);
            ctx.moveTo(X1, right);
            ctx.lineTo(bottom, Y1);
          } else {
            ctx.moveTo(X0, left);
            ctx.lineTo(bottom, Y1);
            ctx.moveTo(top, Y0);
            ctx.lineTo(X1, right);
          }
          break;
      }
    }
  }
}

/**
 * Paints one world rectangle (centred on cx,cz, `span` BU wide) into a canvas of
 * `size` px, a band of rows at a time. The full-screen map drives it with a few
 * dozen rows per slice: a million height samples would otherwise block the page
 * for the better part of a second each time the view changes.
 *
 * The sheet is drawn like an illustrated atlas: hillshade from the north-west
 * (steeper than life, so gentle country still reads), a leafy mottling where
 * plants grow, the grain of paper, and clean height lines on land and under water.
 */
export function mapPainter(field: IslandField, size: number, span: number, cx = 0, cz = 0, contours = true): MapPainter {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const heights = new Float32Array(size * size);

  // one height sample per pixel. Calling field.normal() per pixel would re-run
  // the height field four extra times and made baking a tile take seconds.
  const cellBu = span / size;
  const lin = new Float32Array(3);
  const w: BiomeWeights = { snow: 0, desert: 0, swamp: 0, forest: 0, meadow: 0, volcanic: 0, taiga: 0, jungle: 0, badlands: 0, tundra: 0, highland: 0 };
  const slopeTone = new THREE.Color(0x9cbf89).clone();
  const toByte = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
  // light from the north-west, and how much steeper than life the relief is drawn
  const LX = -0.55;
  const LY = 0.62;
  const LZ = -0.55;
  const RELIEF = 2.2;
  let row = 0;
  let flushed = 0;
  let lined = 0; // height lines drawn so far

  /** heights of one row of the sheet; a row past the bottom repeats the last one */
  const heightsOf = (py: number) => {
    if (py >= size) return;
    const base = py * size;
    const z = cz + (py / size - 0.5) * span;
    for (let px = 0; px < size; px++) heights[base + px] = field.height(cx + (px / size - 0.5) * span, z);
  };

  const paintRow = (py: number) => {
    heightsOf(py + 1);
    const z = cz + (py / size - 0.5) * span;
    const base = py * size;
    const up = Math.max(0, py - 1) * size;
    const down = Math.min(size - 1, py + 1) * size;
    const dz = (down - up) / size;
    for (let px = 0; px < size; px++) {
      const x = cx + (px / size - 0.5) * span;
      const h = heights[base + px];
      const gx = ((heights[base + Math.min(size - 1, px + 1)] - heights[base + Math.max(0, px - 1)]) / (px === 0 || px === size - 1 ? cellBu : 2 * cellBu)) * RELIEF;
      const gz = ((heights[down + px] - heights[up + px]) / (dz * cellBu)) * RELIEF;
      const len = Math.hypot(gx, 1, gz);
      const slope = Math.sqrt(Math.max(0, 1 - 1 / (len * len)));
      // the field returns LINEAR rgb; the canvas wants sRGB bytes, so the map shows the
      // biome swatches as designed instead of a darker version of them
      field.mapColor(x, z, h, lin);
      let r = lin[0];
      let g = lin[1];
      let b = lin[2];
      if (h >= MAP_SHORE) {
        // hillshade: lit where the ground faces the light
        const lit = (-gx * LX + LY - gz * LZ) / len;
        let m = 0.62 + 0.6 * lit;
        // steep faces show their rock
        const k = Math.max(0, Math.min(0.5, (slope - 0.4) * 1.2)) * 0.35;
        if (k > 0) {
          r += (slopeTone.r - r) * k;
          g += (slopeTone.g - g) * k;
          b += (slopeTone.b - b) * k;
        }
        // where plants grow the ground is mottled, like leaves seen from far above
        field.weights(x, z, w);
        const leafy = Math.min(1, w.forest + w.taiga * 0.85 + w.swamp * 0.7 + w.meadow * 0.5);
        if (leafy > 0.02) m *= 1 + field.canopyNoise(x, z) * (0.035 + 0.11 * leafy);
        // the grain of the paper: white noise per dot of the sheet, so it never
        // lines up into a screen
        m *= 1 + (((Math.sin(px * 12.9898 + py * 78.233) * 43758.5453) % 1) - 0.5) * 0.05;
        r *= m;
        g *= m;
        b *= m;
      } else {
        // water: a faint stir, so the sea is not a flat fill
        const m = 1 + field.canopyNoise(x * 0.7 + 31, z * 0.7 - 17) * 0.028;
        r *= m;
        g *= m;
        b *= m;
      }
      const o = (base + px) * 4;
      data[o] = toByte(Math.max(0, Math.min(1, r)));
      data[o + 1] = toByte(Math.max(0, Math.min(1, g)));
      data[o + 2] = toByte(Math.max(0, Math.min(1, b)));
      data[o + 3] = 255;
    }
  };

  const flush = () => {
    if (row > flushed) {
      ctx.putImageData(img, 0, 0, 0, flushed, size, row - flushed);
      flushed = row;
    }
  };

  const unit = Math.max(1, size / 1024); // line weights are given for a 1024 sheet
  const lines: { level: number; style: string; width: number; dash?: number[] }[] = [
    { level: MAP_SHORE, style: 'rgba(40, 104, 112, 0.55)', width: 1.3 },
  ];
  for (const d of DEPTH_LINES) lines.push({ level: d, style: 'rgba(255, 255, 255, 0.5)', width: 1, dash: [7, 7] });
  for (let lv = CONTOUR_STEP; lv <= CONTOUR_TOP; lv += CONTOUR_STEP) {
    const index = lv % (CONTOUR_STEP * 5) === 0;
    lines.push({ level: lv, style: index ? 'rgba(70, 100, 58, 0.42)' : 'rgba(70, 100, 58, 0.26)', width: index ? 1.7 : 1 });
  }

  /** draws up to `count` height lines */
  const drawLines = (count: number) => {
    const end = Math.min(lines.length, lined + count);
    for (; lined < end; lined++) {
      const l = lines[lined];
      ctx.beginPath();
      traceLevel(ctx, heights, size, l.level);
      ctx.setLineDash(l.dash ?? []);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = l.width * unit;
      ctx.strokeStyle = l.style;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };

  return {
    canvas,
    step(rows: number) {
      if (row < size) {
        const end = Math.min(size, row + rows);
        for (; row < end; row++) paintRow(row);
        flush();
      }
      if (row >= size && contours) drawLines(3);
      return row >= size && (!contours || lined >= lines.length);
    },
    finish() {
      if (row < size) {
        for (; row < size; row++) paintRow(row);
        flush();
      }
      if (contours) drawLines(lines.length);
      // widgets read the world span (and centre) back off the canvas
      (canvas as HTMLCanvasElement & { worldSpan?: number }).worldSpan = span;
      (canvas as HTMLCanvasElement & { worldCx?: number }).worldCx = cx;
      (canvas as HTMLCanvasElement & { worldCz?: number }).worldCz = cz;
      return canvas;
    },
  };
}

/** Paints a world rectangle in one go (the boot minimap; anything small enough not to stall the page). */
export function renderMapRegion(
  field: IslandField,
  size: number,
  span: number,
  cx = 0,
  cz = 0,
  contours = true,
): HTMLCanvasElement {
  const painter = mapPainter(field, size, span, cx, cz, contours);
  painter.step(size);
  return painter.finish();
}

export function renderMinimapCanvas(field: IslandField, size: number, span: number): HTMLCanvasElement {
  return renderMapRegion(field, size, span, 0, 0);
}

export { lerp, smoothstep, mulberry32 };
