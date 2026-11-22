import * as THREE from 'three';
import { IslandField, ISLAND_HALF, CHUNK } from './world';
import { PAL } from './palette';
import { fbm, Perlin2, smoothstep, lerp, hash01, clamp01 } from '../lib/noise';

const tmpColor = new THREE.Color();

/**
 * Samples per chunk edge. 14 subdivisions over a 10 BU chunk = ~0.71 BU sampling —
 * fewer faces as requested, while smooth shared-vertex shading keeps slopes
 * reading as continuous ground rather than a polygon mesh.
 */
export const SUBDIV = 14;

export const WORLD_SPAN = 300; // world-space span the map canvas covers

export interface TerrainResult {
  chunks: TerrainChunks;
  coast: THREE.Vector2[];
  triangles: number;
}

/** Deterministic XY jitter keyed by integer grid coords so chunk seams still match. */
function jitter(ix: number, iz: number): [number, number] {
  return [(hash01(ix, iz) - 0.5) * 0.08, (hash01(iz + 41.7, ix - 13.3) - 0.5) * 0.08];
}

/**
 * Surface colour from position + slope. Three biomes share the island instead of
 * one green: meadow on the low centre, dry golden scrub on the sunward flank and
 * cool highland moss on the ridges. The biome mask is low-frequency noise so
 * patches read as regions, not per-face confetti.
 */
function classify(x: number, z: number, h: number, upness: number, n: Perlin2): THREE.Color {
  const slope = Math.sqrt(Math.max(0, 1 - upness * upness));
  const v = fbm(n, x * 0.055, z * 0.055, 3);
  const patch = fbm(n, x * 0.026 + 9.1, z * 0.026 - 4.4, 3);
  const fine = n.noise(x * 0.17, z * 0.17);
  const tint = Math.max(-1, Math.min(1, v * 1.5 + fine * 0.35));

  if (h < -1.4) {
    return tmpColor.setHex(PAL.sandDeep).lerp(new THREE.Color(PAL.rockDark), Math.min(1, -h / 10)).clone();
  }
  if (h < -0.1) {
    return tmpColor.setHex(PAL.sandWet).lerp(new THREE.Color(PAL.sandDeep), Math.min(1, -h / 3.2)).clone();
  }
  if (h < 0.85) {
    const t = smoothstep(-0.1, 0.85, h);
    const wet = new THREE.Color(PAL.sandWet);
    const dry = new THREE.Color(PAL.sandLight).lerp(new THREE.Color(PAL.sandMid), 0.4 + tint * 0.2);
    return wet.lerp(dry, t * 0.9 + 0.1);
  }

  const rockT = smoothstep(0.55, 0.88, slope);
  if (rockT > 0.01) {
    const rock = new THREE.Color(PAL.rockMid).lerp(new THREE.Color(PAL.rockLight), 0.38 + tint * 0.24);
    const grassy = new THREE.Color(PAL.moss).lerp(new THREE.Color(PAL.grassMid), 0.55);
    return grassy.clone().lerp(rock, rockT * 0.7);
  }

  // biome mask: -1 dry scrub, 0 meadow, +1 highland moss
  const biome = fbm(n, x * 0.0135 + 3.7, z * 0.0135 - 8.2, 3);
  const highland = smoothstep(6.4, 11.4, h);
  const mixHigh = clamp01(biome * 0.7 + 0.25 + highland * 0.75);
  const mixDry = clamp01(-biome * 1.15 + (1 - highland) * 0.18 - 0.1);

  // meadow: fresh greens with a warm sunlit crown
  const deepGreen = new THREE.Color(0x4e8a45);
  const freshGreen = new THREE.Color(0x74b25c);
  const sunGreen = new THREE.Color(0x9ccb6e);
  const broad = patch * 0.5 + 0.5;
  const local = tint * 0.5 + 0.5;
  const meadow = deepGreen.clone().lerp(freshGreen, broad * 0.7 + local * 0.32);
  meadow.lerp(sunGreen, Math.max(0, upness - 0.6) * 1.3);

  // dry scrub: straw and olive, only on gentle low ground so cliffs stay rocky
  const straw = new THREE.Color(0xb9bd74).lerp(new THREE.Color(0xc9c98a), local * 0.5);
  const olive = new THREE.Color(0x8d9a52);
  const dry = olive.clone().lerp(straw, 0.35 + broad * 0.5);
  dry.lerp(new THREE.Color(0xd6d29a), Math.max(0, upness - 0.72) * 0.8);

  // highland: cool moss over grey stone
  const moss = new THREE.Color(0x7fa86a).lerp(new THREE.Color(0x5f8a5c), local * 0.5);
  const highStone = new THREE.Color(0x9aa8a0);
  const high = moss.clone().lerp(highStone, 0.22 + broad * 0.24);

  const c = meadow.clone().lerp(dry, mixDry * 0.82);
  c.lerp(high, mixHigh * 0.62);

  if (h > 10.5) c.lerp(new THREE.Color(0xcfdcd2), smoothstep(10.5, 14.5, h) * 0.42);
  c.lerp(deepGreen, Math.max(0, 0.66 - upness) * 0.7);
  return c;
}

/** Trace the coastline around a centre: rays + bisection on h=0. */
export function traceCoast(
  field: IslandField,
  rays = 320,
  center: { x: number; z: number } = { x: 0, z: 0 },
  maxDist = 66,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let lo = 0;
    let hi = 0;
    for (let r = 2; r < maxDist; r += 0.6) {
      if (field.height(center.x + dx * r, center.z + dz * r) < 0) {
        hi = r;
        lo = r - 0.6;
        break;
      }
    }
    if (hi === 0) {
      out.push(new THREE.Vector2(center.x + dx * 44, center.z + dz * 44));
      continue;
    }
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) * 0.5;
      if (field.height(center.x + dx * mid, center.z + dz * mid) < 0) hi = mid;
      else lo = mid;
    }
    const r = (lo + hi) * 0.5;
    out.push(new THREE.Vector2(center.x + dx * r, center.z + dz * r));
  }
  return out;
}

/** Cliff strata + tapered underside built from a coastline loop (kept faceted). */
function buildCliff(coast: THREE.Vector2[], field: IslandField, n: Perlin2, centre: { x: number; z: number }): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];

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

  const ringAt = (band: number) => {
    const b = bands[band];
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < coast.length; i++) {
      const p = coast[i];
      const vx = p.x - centre.x;
      const vz = p.y - centre.z;
      const len = Math.hypot(vx, vz) || 1;
      const dirx = vx / len;
      const dirz = vz / len;
      const wob = n.noise(dirx * 2.2 + band * 0.7, dirz * 2.2 - band * 0.4) * 0.9;
      const r = len - b.inset + wob * Math.min(1, b.inset * 0.35 + 0.15);
      const x = centre.x + dirx * r;
      const z = centre.z + dirz * r;
      const ripple = n.noise(x * 0.4, z * 0.4 + band * 1.7) * 0.28;
      ring.push(new THREE.Vector3(x, field.height(x, z) * 0.15 - b.drop + ripple, z));
    }
    return ring;
  };

  const rings: THREE.Vector3[][] = [];
  for (let b = 0; b < bands.length; b++) rings.push(ringAt(b));

  const strataColors = [
    PAL.sandWet,
    PAL.sandDeep,
    0xa48f6d,
    0x8e7c63,
    0x7a6d5b,
    0x6a6357,
    0x5b5f5c,
    0x4e5658,
    0x454e53,
    0x3d454a,
  ];

  for (let b = 0; b < rings.length - 1; b++) {
    const shadeA = new THREE.Color(strataColors[b]);
    const shadeB = new THREE.Color(strataColors[b + 1]);
    for (let i = 0; i < coast.length; i++) {
      const i2 = (i + 1) % coast.length;
      const a = rings[b][i];
      const bb = rings[b][i2];
      const c = rings[b + 1][i2];
      const d = rings[b + 1][i];
      const mix = new THREE.Color().lerpColors(shadeA, shadeB, 0.5);
      const wob = n.noise((a.x + bb.x) * 0.11, (a.z + bb.z) * 0.11) * 0.06;
      mix.offsetHSL(0, 0, wob);
      pos.push(a.x, a.y, a.z, bb.x, bb.y, bb.z, c.x, c.y, c.z);
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      for (let k = 0; k < 6; k++) col.push(mix.r, mix.g, mix.b);
    }
  }

  const last = rings[rings.length - 1];
  let cxm = 0;
  let czm = 0;
  for (const p of last) {
    cxm += p.x;
    czm += p.z;
  }
  cxm /= last.length;
  czm /= last.length;
  const bottom = new THREE.Vector3(cxm, -21.5, czm);
  const under = new THREE.Color(0x37454d);
  for (let i = 0; i < last.length; i++) {
    const i2 = (i + 1) % last.length;
    pos.push(last[i].x, last[i].y, last[i].z, last[i2].x, last[i2].y, last[i2].z, bottom.x, bottom.y, bottom.z);
    for (let k = 0; k < 3; k++) col.push(under.r, under.g, under.b);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** One chunk mesh: indexed shared-vertex grid, analytic normals, smooth shading. */
function buildChunkMesh(field: IslandField, n: Perlin2, cx: number, cz: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const step = CHUNK / SUBDIV;
  const row = SUBDIV + 1;
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;

  for (let j = 0; j <= SUBDIV; j++) {
    for (let i = 0; i <= SUBDIV; i++) {
      const ix = cx * SUBDIV + i;
      const iz = cz * SUBDIV + j;
      const [jx, jz] = jitter(ix, iz);
      const x = ox + i * step + jx;
      const z = oz + j * step + jz;
      const h = field.height(x, z);
      const nrm = field.normal(x, z);
      positions.push(x, h, z);
      normals.push(nrm[0], nrm[1], nrm[2]);
      const c = classify(x, z, h, nrm[1], n);
      colors.push(c.r, c.g, c.b);
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
  return geo;
}

/** Chunked terrain: chunks are built on demand so new regions can extend the world. */
export class TerrainChunks {
  readonly group = new THREE.Group();
  private chunks = new Map<string, THREE.Mesh>();
  private mat: THREE.MeshStandardMaterial;
  private n: Perlin2;
  triangleCount = 0;

  constructor(private field: IslandField, seed: number) {
    this.n = new Perlin2(seed + 71);
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    this.group.name = 'Terrain_Chunks';
  }

  has(cx: number, cz: number): boolean {
    return this.chunks.has(`${cx}_${cz}`);
  }

  /**
   * Builds (or REBUILDS) one chunk. Rebuilding matters: when a new region raises
   * ground that an existing chunk already covers, the old mesh keeps the old
   * height field — that stale surface is what produced the vertical wall of
   * interpenetrating triangles at every region seam.
   */
  buildChunk(cx: number, cz: number, force = false): boolean {
    const key = `${cx}_${cz}`;
    const existing = this.chunks.get(key);
    if (existing) {
      if (!force) return false;
      this.triangleCount -= existing.geometry.getIndex()!.count / 3;
      existing.geometry.dispose();
      const geo = buildChunkMesh(this.field, this.n, cx, cz);
      existing.geometry = geo;
      this.triangleCount += geo.getIndex()!.count / 3;
      return true;
    }
    const geo = buildChunkMesh(this.field, this.n, cx, cz);
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    mesh.name = `Chunk_${cx}_${cz}`;
    this.chunks.set(key, mesh);
    this.group.add(mesh);
    this.triangleCount += geo.getIndex()!.count / 3;
    return true;
  }

  /** Chunk meshes touched by the last buildDisc, so callers can fog-reveal them. */
  readonly lastBuilt: THREE.Mesh[] = [];

  /** Builds every chunk overlapping the disc (centre, radius). */
  buildDisc(cx: number, cz: number, radius: number, force = false): number {
    this.lastBuilt.length = 0;
    const c0 = Math.floor((cx - radius) / CHUNK);
    const c1 = Math.floor((cx + radius) / CHUNK);
    const r0 = Math.floor((cz - radius) / CHUNK);
    const r1 = Math.floor((cz + radius) / CHUNK);
    let built = 0;
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        // a rebuilt chunk is an existing mesh with fresh geometry — the caller
        // must not treat it as brand-new (it is already on screen and already
        // has a material, so re-wrapping it in the fog reveal would double it)
        const existed = this.chunks.has(`${i}_${j}`);
        if (this.buildChunk(i, j, force) && !existed) {
          this.lastBuilt.push(this.chunks.get(`${i}_${j}`)!);
          built++;
        }
      }
    }
    return built;
  }

  /** Builds the birth-island chunk range. */
  buildBirthIsland(): number {
    return this.buildDisc(0, 0, ISLAND_HALF);
  }
}

export function buildTerrain(field: IslandField, seed: number, coast: THREE.Vector2[]): TerrainResult {
  const chunks = new TerrainChunks(field, seed);
  const tris = chunks.buildBirthIsland();
  void coast;
  // the cliff skirt and foam ring are built by the engine (rebuildShore), because
  // they must be retraced every time the landmass grows — see buildMergedCliff
  return { chunks, coast, triangles: tris };
}

/**
 * Cliff skirt for the WHOLE merged landmass. Generated islands are no longer
 * given their own skirt: a skirt traced around one dome runs straight through
 * the island it merged into, and that wall of interpenetrating rock was the
 * "接壤的地方穿模" report. One skirt per world, retraced whenever the land grows.
 */
export function buildMergedCliff(field: IslandField, seed: number, maxDist: number): THREE.Mesh {
  const coast = traceCoast(field, 300, { x: 0, z: 0 }, maxDist);
  const n = new Perlin2(seed + 71);
  const geo = buildCliff(coast, field, n, { x: 0, z: 0 });
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Terrain_Cliff';
  return mesh;
}

/** Region generation: builds every terrain chunk the new land overlaps. */
export function buildRegionTerrain(
  _field: IslandField,
  _seed: number,
  chunks: TerrainChunks,
  centre: { x: number; z: number },
  radius: number,
): number {
  // Force-rebuild: the new dome raises ground inside chunks that already exist,
  // and the old geometry kept the old height field, leaving a visible seam wall.
  return chunks.buildDisc(centre.x, centre.z, radius * 1.35, true);
}

/** Foam ribbon hugging the coast, drawn just above the water surface. */
export function buildFoam(coast: THREE.Vector2[], seed: number): THREE.Mesh {
  const n = new Perlin2(seed + 313);
  const pos: number[] = [];
  const col: number[] = [];
  const c1 = new THREE.Color(PAL.waterFoam);
  const c2 = new THREE.Color(0xbfe9de);

  const widthAt = (i: number) => 0.55 + (n.noise(i * 0.14, 2.7) * 0.5 + 0.5) * 1.5;

  for (let i = 0; i < coast.length; i++) {
    const i2 = (i + 1) % coast.length;
    const p = coast[i];
    const q = coast[i2];
    const w = widthAt(i);
    const w2 = widthAt(i2);
    const dp = p.clone().normalize();
    const dq = q.clone().normalize();
    const a = new THREE.Vector3(p.x - dp.x * 0.6, 0.12, p.y - dp.y * 0.6);
    const b = new THREE.Vector3(p.x + dp.x * w, 0.1, p.y + dp.y * w);
    const c = new THREE.Vector3(q.x + dq.x * w2, 0.1, q.y + dq.y * w2);
    const d = new THREE.Vector3(q.x - dq.x * 0.6, 0.12, q.y - dq.y * 0.6);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    for (let k = 0; k < 6; k++) {
      const cc = k % 3 === 1 ? c2 : c1;
      col.push(cc.r, cc.g, cc.b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.name = 'Foam_Ring';
  return mesh;
}

/** Map palette, shared by the HUD minimap and the full-screen map. */
const MAP_COL = {
  landLight: new THREE.Color(0xc8e2ad),
  landDeep: new THREE.Color(0xa8ce93),
  high: new THREE.Color(0xe4edc7),
  sand: new THREE.Color(0xf3ecdc),
  slopeTone: new THREE.Color(0x9cbf89),
  shallow: new THREE.Color(0xd7ecef),
  deep: new THREE.Color(0xafd6e2),
};

/**
 * Paints one world rectangle (centred on cx,cz, `span` BU wide) into a canvas of
 * `size` px. Used both for the baked minimap and for the infinite full-screen
 * map, which re-renders only the strip it is missing as the player pans.
 */
export function renderMapRegion(
  field: IslandField,
  size: number,
  span: number,
  cx = 0,
  cz = 0,
  contours = true,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const c = new THREE.Color();
  const heights = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = cx + (px / size - 0.5) * span;
      const z = cz + (py / size - 0.5) * span;
      heights[py * size + px] = field.height(x, z);
    }
  }

  // one height sample per pixel; the slope comes from the grid itself. Calling
  // field.normal() per pixel would re-run the height field four extra times and
  // made baking a tile take seconds.
  const cellBu = span / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const h = heights[py * size + px];
      const hl = heights[py * size + Math.max(0, px - 1)];
      const hr = heights[py * size + Math.min(size - 1, px + 1)];
      const hu = heights[Math.max(0, py - 1) * size + px];
      const hd = heights[Math.min(size - 1, py + 1) * size + px];
      const nx = -(hr - hl) / (2 * cellBu);
      const nz = -(hd - hu) / (2 * cellBu);
      const upness = 1 / Math.sqrt(1 + nx * nx + nz * nz);
      const slope = Math.sqrt(Math.max(0, 1 - upness * upness));
      if (h < -0.2) {
        const t = Math.max(0, Math.min(1, -h / 6));
        c.copy(MAP_COL.shallow).lerp(MAP_COL.deep, t);
      } else if (h < 0.85) {
        c.copy(MAP_COL.sand);
      } else {
        c.copy(MAP_COL.landDeep).lerp(MAP_COL.landLight, Math.max(0, Math.min(1, (h - 1) / 9)));
        c.lerp(MAP_COL.high, Math.max(0, Math.min(1, (h - 11) / 6)) * 0.7);
        c.lerp(MAP_COL.slopeTone, Math.max(0, Math.min(0.5, (slope - 0.4) * 1.2)));
        // hillshade: a NW light gives the flat sheet readable relief, like an
        // engraved map, without any 3D pass
        if (px > 0 && py > 0) {
          const shade = Math.max(-1, Math.min(1, (h - hl + h - hu) * 0.55));
          c.offsetHSL(0, 0, shade * 0.055);
        }
      }
      const o = (py * size + px) * 4;
      data[o] = c.r * 255;
      data[o + 1] = c.g * 255;
      data[o + 2] = c.b * 255;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (contours) {
    // height contours: mark cells whose sampled height sits just above each
    // contour level, then stroke short arcs through the marks
    const cell = span / size;
    const levels = [2, 4, 6, 8, 10, 12, 14, 16];
    const scale = size / 512;
    ctx.strokeStyle = 'rgba(112, 150, 100, 0.28)';
    ctx.lineWidth = Math.max(1, scale);
    for (let l = 0; l < levels.length; l++) {
      const lv = levels[l];
      const step = l === 6 ? 4 : 3; // keep the outer contours legible
      for (let py = 1; py < size - 1; py += step) {
        for (let px = 1; px < size - 1; px += step) {
          const h = heights[py * size + px];
          const up = heights[(py - 1) * size + px];
          const left = heights[py * size + px - 1];
          if (h <= lv && (up > lv || left > lv)) {
            ctx.beginPath();
            ctx.moveTo((px + 0.5) * cell, (py + 0.5) * cell);
            ctx.lineTo((px + 1.9) * cell, (py + 0.5) * cell);
            ctx.stroke();
          }
        }
      }
    }
  }

  // widgets read the world span (and centre) back off the canvas
  (canvas as HTMLCanvasElement & { worldSpan?: number }).worldSpan = span;
  (canvas as HTMLCanvasElement & { worldCx?: number }).worldCx = cx;
  (canvas as HTMLCanvasElement & { worldCz?: number }).worldCz = cz;
  return canvas;
}

/**
 * Bakes the map snapshot used by the HUD minimap. Kept as a thin alias so the
 * engine's single call site reads as "the world's map image".
 */
export function renderMinimapCanvas(field: IslandField, size: number, span: number): HTMLCanvasElement {
  return renderMapRegion(field, size, span, 0, 0);
}

export { lerp, smoothstep };
