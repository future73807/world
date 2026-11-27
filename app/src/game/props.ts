import * as THREE from 'three';
import { IslandField, TILE, SEA, tileKey, tileOf, TileState } from './world';
import { AssetLibrary, materialFor, ModelEntry } from './assets';
import { mulberry32, lerp } from '../lib/noise';
import { SPECIES, LANDMARKS } from './biomes';
import type { BiomeWeights, PropRule, SpeciesRule } from './biomes';

/**
 * Everything standing on the ground: where each prefab instance is, and the
 * instanced meshes that draw them.
 *
 * Instances never move, so each one owns its matrix. The renderer only decides,
 * a few times a second, which instances are near the player (full-detail mesh)
 * and which are in the far ring (decimated mesh); everything beyond the fog is
 * not drawn at all.
 */
export interface PropInstance {
  model: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  matrix: THREE.Matrix4;
  /** collision + camera-occlusion cylinder; all zero for walk-through detail */
  r: number;
  top: number;
  /** a model that stands on several feet (an arch): one cylinder per foot, in world space */
  shape?: { x: number; z: number; r: number; top: number }[];
  crownR: number;
  solid: boolean;
  spacing: number;
  tile: number;
  fade: number;
  /** seconds to keep the instance invisible before it fades in (staggered reveal) */
  hold: number;
}

const HASH_CELL = 4;

export class PropSet {
  all: PropInstance[] = [];
  byTile = new Map<number, PropInstance[]>();
  byModel = new Map<string, PropInstance[]>();
  private hash = new Map<number, PropInstance[]>();
  version = 0;
  private stamp = 0;

  add(tile: number, list: PropInstance[]) {
    if (!list.length) return;
    const cur = this.byTile.get(tile) ?? [];
    this.byTile.set(tile, cur.concat(list));
    for (const p of list) {
      this.all.push(p);
      const m = this.byModel.get(p.model);
      if (m) m.push(p);
      else this.byModel.set(p.model, [p]);
      const k = hashKey(p.x, p.z);
      const h = this.hash.get(k);
      if (h) h.push(p);
      else this.hash.set(k, [p]);
    }
    this.version++;
  }

  removeTile(tile: number) {
    const list = this.byTile.get(tile);
    if (!list) return;
    const gone = new Set(list);
    this.byTile.delete(tile);
    this.all = this.all.filter((p) => !gone.has(p));
    for (const [id, arr] of this.byModel) {
      const kept = arr.filter((p) => !gone.has(p));
      if (kept.length) this.byModel.set(id, kept);
      else this.byModel.delete(id);
    }
    this.rehash();
    this.version++;
  }

  clear() {
    this.all = [];
    this.byTile.clear();
    this.byModel.clear();
    this.hash.clear();
    this.version++;
  }

  private rehash() {
    this.hash.clear();
    for (const p of this.all) {
      const k = hashKey(p.x, p.z);
      const h = this.hash.get(k);
      if (h) h.push(p);
      else this.hash.set(k, [p]);
    }
  }

  /** Instances within `r` of a point (deduplicated). */
  near(x: number, z: number, r: number, out: PropInstance[]): PropInstance[] {
    out.length = 0;
    const s = ++this.stamp;
    const c0 = Math.floor((x - r) / HASH_CELL);
    const c1 = Math.floor((x + r) / HASH_CELL);
    const d0 = Math.floor((z - r) / HASH_CELL);
    const d1 = Math.floor((z + r) / HASH_CELL);
    const r2 = r * r;
    for (let j = d0; j <= d1; j++) {
      for (let i = c0; i <= c1; i++) {
        const list = this.hash.get((i + 512) * 4096 + (j + 512));
        if (!list) continue;
        for (const p of list) {
          if ((p as unknown as { _s?: number })._s === s) continue;
          (p as unknown as { _s?: number })._s = s;
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz < r2) out.push(p);
        }
      }
    }
    return out;
  }
}

function hashKey(x: number, z: number): number {
  return (Math.floor(x / HASH_CELL) + 512) * 4096 + (Math.floor(z / HASH_CELL) + 512);
}

export interface Avoid {
  x: number;
  z: number;
  r: number;
  /** only keep solid props (trees, rocks, landmarks) out; ground cover may grow here */
  solidOnly?: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function instanceOf(entry: ModelEntry, x: number, y: number, z: number, slope: number, nrm: [number, number, number], s: number, rot: number, tile: number, spacing: number): PropInstance {
  const solid = !!entry.collide;
  const sink = solid ? entry.sink + slope * 1.2 : 0.03;
  _p.set(x, y - sink * s, z);
  _qy.setFromAxisAngle(UP, rot);
  if (solid) {
    // lean about half-way toward the surface normal (not fully: a fully
    // normal-aligned tree on a steep bank reads as falling over)
    _axis.set(-nrm[2], 0, nrm[0]);
    if (_axis.lengthSq() > 1e-6) {
      _axis.normalize();
      _tilt.setFromAxisAngle(_axis, Math.acos(Math.max(-1, Math.min(1, nrm[1]))) * 0.5);
      _q.copy(_qy).premultiply(_tilt);
    } else {
      _q.copy(_qy);
    }
  } else {
    _q.copy(_qy);
  }
  _s.set(s, s * (0.94 + (rot / (Math.PI * 2)) * 0.15), s);
  _m.compose(_p, _q, _s);
  // one foot: one cylinder round it. Several feet (an arch, a rib cage): a cylinder
  // each, turned with the instance, so the opening between them stays open to walk through
  const col = entry.collide;
  const feet = solid && Array.isArray(col) ? col : null;
  let r = 0;
  let top = 0;
  let shape: PropInstance['shape'];
  if (solid && feet) {
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    shape = feet.map((c) => {
      r = Math.max(r, (Math.hypot(c.x, c.z) + c.r) * s);
      top = Math.max(top, _p.y + c.h * s);
      return { x: x + (c.x * cr + c.z * sr) * s, z: z + (-c.x * sr + c.z * cr) * s, r: c.r * s, top: _p.y + c.h * s };
    });
  } else if (solid && col) {
    r = (col as { r: number }).r * s;
    top = y + (col as { h: number }).h * s;
  }
  const crown = entry.kind === 'tree' || entry.kind === 'landmark';
  return {
    model: entry.id,
    x,
    y,
    z,
    scale: s,
    matrix: _m.clone(),
    r,
    top,
    shape,
    crownR: crown ? r + 1.15 * s : r,
    solid,
    spacing,
    tile,
    fade: 1,
    hold: 0,
  };
}

/**
 * Places one tile's props. A tile with a card grows what the card asked for; any
 * other tile grows whatever its climate supports: every species of the table, as
 * dense as its niche is at each spot, so the vegetation changes with the climate
 * and not at the tile's edge. Landmarks go first (each claims a clearing), then
 * trees, rocks and ground cover respect each other's spacing.
 */
export function scatterTile(
  field: IslandField,
  tile: TileState,
  library: AssetLibrary,
  set: PropSet,
  seed: number,
  avoid: Avoid[],
): { placed: PropInstance[]; missing: string[] } {
  const rnd = mulberry32(seed);
  const placed: PropInstance[] = [];
  const missing: string[] = [];
  const key = tileKey(tile.x, tile.z);
  const scratch: PropInstance[] = [];
  const w: BiomeWeights = { snow: 0, desert: 0, swamp: 0, forest: 0, meadow: 0, volcanic: 0, taiga: 0, jungle: 0, badlands: 0, tundra: 0, highland: 0, glacier: 0 };
  const tm: [number, number] = [0, 0];

  // what to grow, and how much of it. A species' niche, averaged over the tile,
  // turns "this dense where it is at home" into a number of plants to expect here.
  interface Job {
    rule: PropRule;
    niche?: SpeciesRule['niche'];
    target: number;
  }
  const jobs: Job[] = [];
  if (tile.props) {
    for (const rule of tile.props) jobs.push({ rule, target: rule.n });
  } else {
    const N = 7;
    const speciesSum = new Float64Array(SPECIES.length);
    const landmarkSum = new Float64Array(LANDMARKS.length);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = tile.x * TILE + ((i + 0.5) / N - 0.5) * TILE;
        const z = tile.z * TILE + ((j + 0.5) / N - 0.5) * TILE;
        field.weights(x, z, w);
        field.climate(x, z, tm);
        SPECIES.forEach((s, k) => (speciesSum[k] += Math.min(1, s.niche(w, tm[0], tm[1]))));
        LANDMARKS.forEach((s, k) => (landmarkSum[k] += Math.min(1, s.niche(w, tm[0], tm[1]))));
      }
    }
    const n = N * N;
    SPECIES.forEach((s, k) => {
      const a = speciesSum[k] / n;
      if (a > 0.035) jobs.push({ rule: s, niche: s.niche, target: s.n * a });
      else if (s.model.startsWith('cc0_') && /deer|fox|cat|chicken|cow|frog|hedgehog|campfire|barrel|crate|cart|hay|boat/.test(s.model)) {
        console.log('[props] fauna rule below gate', s.model, 'a=', a.toFixed(4), 'n=', s.n);
      }
    });
    // one landmark at most, and only where it is truly at home
    let best = -1;
    let bestA = 0.5;
    LANDMARKS.forEach((_s, k) => {
      const a = landmarkSum[k] / n;
      if (a > bestA) {
        bestA = a;
        best = k;
      }
    });
    if (best >= 0) jobs.push({ rule: LANDMARKS[best], niche: LANDMARKS[best].niche, target: 1 });
  }
  // what the region's card adds on top of the climate: a landmark, models Blender
  // built for it, the things a wish asked for. The vegetation itself is never listed.
  for (const rule of tile.spec.extra ?? []) jobs.push({ rule, target: rule.n });
  jobs.sort((a, b) => (b.rule.landmark ? 1 : 0) - (a.rule.landmark ? 1 : 0));

  const blocked = (x: number, z: number, solid: boolean) => {
    for (const a of avoid) {
      if (a.solidOnly && !solid) continue;
      const dx = x - a.x;
      const dz = z - a.z;
      if (dx * dx + dz * dz < a.r * a.r) return true;
    }
    return false;
  };
  // Spacing is NOT symmetric. Two solid props (trees, rocks, landmarks) keep
  // their own spacing from each other, but ground cover only has to clear its own
  // spacing and the trunk it would otherwise grow through. Applying a tree's 4 BU
  // spacing to every blade of grass left a bare ring around each trunk.
  // A solid prop (tree, rock, animal) does NOT have to clear ground cover: grass and
  // flowers grow right up to a trunk, and an animal standing in a meadow is standing in
  // grass. Returning 0 for that pair is what lets wide-spaced rules place at all — with
  // spacing*0.5 they collided with the nearest blade of grass and every candidate failed.
  const limit = (spacing: number, solid: boolean, p: PropInstance) =>
    solid && p.solid
      ? Math.max(spacing, p.spacing) // two solid props honour both their spacings
      : solid
        ? 0 // a solid prop ignores ground cover entirely
        : p.solid
          ? p.r + 0.3 // ground cover clears the trunk, that is all
          : spacing * 0.5; // two plants just must not sit on the same spot
  const crowded = (x: number, z: number, spacing: number, solid: boolean) => {
    for (const p of placed) {
      const lim = limit(spacing, solid, p);
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }
    const reach = spacing + 11; // the widest spacing a rule may ask for
    for (const p of set.near(x, z, reach, scratch)) {
      const lim = limit(spacing, solid, p);
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }
    return false;
  };

  interface Spot {
    x: number;
    z: number;
    h: number;
    slope: number;
    nrm: [number, number, number];
  }

  // one random candidate that satisfies a job's constraints, or null
  const candidate = (job: Job, spread: number): Spot | null => {
    const rule = job.rule;
    const x = tile.x * TILE + (rnd() * 2 - 1) * spread * TILE;
    const z = tile.z * TILE + (rnd() * 2 - 1) * spread * TILE;
    // only inside this tile's own cell: the neighbours fill their side by the same rule
    const [tx, tz] = tileOf(x, z);
    if (tx !== tile.x || tz !== tile.z) return null;
    const h = field.height(x, z);
    if (h < (rule.minH ?? (rule.water ? -2 : 0.4)) || h > (rule.maxH ?? (rule.water ? -0.1 : 40))) return null;
    if (rule.cluster !== undefined && field.patchNoise(x, z) < rule.cluster) return null;
    // the climate decides, spot by spot (the field keeps what it sampled for this point)
    if (job.niche) {
      field.weights(x, z, w);
      field.climate(x, z, tm);
      const k = job.niche(w, tm[0], tm[1]);
      if (k <= 0.02 || rnd() > Math.min(1, k)) return null;
    }
    const slope = field.slope(x, z);
    if (slope > (rule.maxSlope ?? 0.7)) return null;
    if (blocked(x, z, !!library.get(rule.model)?.entry.collide)) return null;
    return { x, z, h, slope, nrm: [0, 1, 0] as [number, number, number] };
  };

  for (const job of jobs) {
    const rule = job.rule;
    const lib = library.get(rule.model);
    if (!lib) {
      missing.push(rule.model);
      continue;
    }
    const entry = lib.entry;
    const spacing = rule.spacing ?? 1.2;
    if (rule.landmark) {
      // a landmark takes the flattest free spot in the inner part of the tile,
      // so it never hangs off a bank or lands on top of something else
      let best: Spot | null = null;
      for (let k = 0; k < 70; k++) {
        const c = candidate(job, 0.3);
        if (c && !crowded(c.x, c.z, spacing, true) && (!best || c.slope < best.slope)) best = c;
      }
      if (best) {
        best.nrm = field.normal(best.x, best.z);
        const sc = lerp(entry.scale[0], entry.scale[1], rnd()) * (rule.scale ? lerp(rule.scale[0], rule.scale[1], rnd()) : 1);
        const inst = instanceOf(entry, best.x, best.h, best.z, best.slope, best.nrm, sc, rnd() * Math.PI * 2, key, spacing);
        placed.push(inst);
        // and claims a clearing around itself
        avoid.push({ x: best.x, z: best.z, r: entry.size[0] * 0.55 + 2.2 });
      }
      continue;
    }
    let tries = Math.round(job.target) * 14 + 20;
    let made = 0;
    while (made < job.target && tries-- > 0) {
      const c = candidate(job, 0.5);
      if (!c || crowded(c.x, c.z, spacing, !!entry.collide)) continue;
      const sc = lerp(entry.scale[0], entry.scale[1], rnd()) * (rule.scale ? lerp(rule.scale[0], rule.scale[1], rnd()) : 1);
      const inst = instanceOf(entry, c.x, rule.water ? SEA + 0.06 : c.h, c.z, c.slope, field.normal(c.x, c.z), sc, rnd() * Math.PI * 2, key, spacing);
      placed.push(inst);
      made++;
    }
  }
  return { placed, missing };
}

interface MeshSet {
  entry: ModelEntry;
  list: PropInstance[];
  near: THREE.InstancedMesh;
  far: THREE.InstancedMesh;
  glowNear: THREE.InstancedMesh | null;
  glowFar: THREE.InstancedMesh | null;
  nearOcc: PropInstance[];
  farOcc: PropInstance[];
}

export class PropRenderer {
  readonly group = new THREE.Group();
  /** every instanced mesh that carries the per-instance fade attribute */
  readonly fadeMeshes: THREE.InstancedMesh[] = [];
  private sets = new Map<string, MeshSet>();
  private library: AssetLibrary;
  private lastX = 1e9;
  private lastZ = 1e9;
  nearRadius = 34;
  farRadius = 62;

  constructor(library: AssetLibrary) {
    this.library = library;
    this.group.name = 'Props';
  }

  private make(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow: boolean, fade?: THREE.InstancedBufferAttribute): THREE.InstancedMesh {
    // share the position/colour buffers with the library; only the fade attribute is per mesh
    const g = new THREE.BufferGeometry();
    g.setIndex(geo.index ? geo.index : null);
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.boundingSphere = geo.boundingSphere ? geo.boundingSphere.clone() : null;
    // a glow sub-mesh passes its base mesh's attribute, so one write fades both
    const fades = fade ? (fade.array as Float32Array) : new Float32Array(n).fill(1);
    g.setAttribute('aFade', fade ?? new THREE.InstancedBufferAttribute(fades, 1));
    const im = new THREE.InstancedMesh(g, mat, n);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.userData.fades = fades;
    if (!fade) this.fadeMeshes.push(im);
    this.group.add(im);
    return im;
  }

  /** Rebuilds every mesh after instances were added or removed. */
  sync(set: PropSet) {
    for (const s of this.sets.values()) {
      for (const m of [s.near, s.far, s.glowNear, s.glowFar]) {
        if (!m) continue;
        this.group.remove(m);
        // drop the per-mesh attribute first: the shared buffers must stay alive
        m.geometry.deleteAttribute('aFade');
        m.geometry.dispose();
      }
    }
    this.sets.clear();
    this.fadeMeshes.length = 0;
    for (const [id, list] of set.byModel) {
      const lib = this.library.get(id);
      if (!lib || !list.length) continue;
      const n = list.length;
      const e = lib.entry;
      const base = materialFor(e, false);
      const glow = lib.glowNear ? materialFor(e, true) : null;
      const near = this.make(lib.near, base, n, e.castShadow);
      const far = this.make(lib.far !== lib.near ? lib.far : lib.near, base, n, false);
      const ms: MeshSet = {
        entry: e,
        list,
        near,
        far,
        glowNear: glow && lib.glowNear ? this.make(lib.glowNear, glow, n, false, near.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute) : null,
        glowFar: glow && lib.glowFar ? this.make(lib.glowFar, glow, n, false, far.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute) : null,
        nearOcc: new Array(n),
        farOcc: new Array(n),
      };
      near.userData.occ = ms.nearOcc;
      far.userData.occ = ms.farOcc;
      this.sets.set(id, ms);
    }
    this.lastX = 1e9;
    this.lastZ = 1e9;
    if (!this.farVisible) this.setFarVisible(false);
  }

  /** Sparse mode: skip the far ring of detail entirely. */
  setFarVisible(v: boolean) {
    this.farVisible = v;
    for (const s of this.sets.values()) {
      s.far.visible = v;
      if (s.glowFar) s.glowFar.visible = v;
    }
  }

  private farVisible = true;

  /**
   * Assigns instances to the near and far meshes around the player. Cheap enough
   * to run whenever the player has moved a few BU, so detail follows them.
   */
  update(px: number, pz: number, force = false): boolean {
    if (!force && (px - this.lastX) ** 2 + (pz - this.lastZ) ** 2 < 9) return false;
    this.lastX = px;
    this.lastZ = pz;
    for (const s of this.sets.values()) {
      const small = s.entry.kind === 'plant' || s.entry.kind === 'detail' || Math.max(...s.entry.size) < 1.4;
      const radius = s.entry.kind === 'landmark' ? Math.max(this.nearRadius, s.entry.farCut) : small ? 10 : s.entry.kind === 'shrub' ? 12 : this.nearRadius;
      const farSet = small ? 22 : s.entry.kind === 'shrub' ? 24 : this.farRadius;
      const nearSet2 = radius * radius;
      const farSet2 = farSet * farSet;
      let ni = 0;
      let fi = 0;
      const fn = s.near.userData.fades as Float32Array;
      const ff = s.far.userData.fades as Float32Array;
      for (const p of s.list) {
        const dx = p.x - px;
        const dz = p.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearSet2) {
          s.near.setMatrixAt(ni, p.matrix);
          s.glowNear?.setMatrixAt(ni, p.matrix);
          fn[ni] = p.fade;
          s.nearOcc[ni] = p;
          ni++;
        } else if (d2 < farSet2) {
          s.far.setMatrixAt(fi, p.matrix);
          s.glowFar?.setMatrixAt(fi, p.matrix);
          ff[fi] = p.fade;
          s.farOcc[fi] = p;
          fi++;
        }
      }
      s.near.count = ni;
      s.far.count = fi;
      s.near.instanceMatrix.needsUpdate = true;
      s.far.instanceMatrix.needsUpdate = true;
      (s.near.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (s.far.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
      if (s.glowNear) {
        s.glowNear.count = ni;
        s.glowNear.instanceMatrix.needsUpdate = true;
      }
      if (s.glowFar) {
        s.glowFar.count = fi;
        s.glowFar.instanceMatrix.needsUpdate = true;
      }
    }
    return true;
  }

  /** Near/far instance lists of one mesh, for the camera fade test. */
  occludersOf(mesh: THREE.InstancedMesh): PropInstance[] | null {
    for (const s of this.sets.values()) {
      if (s.near === mesh) return s.nearOcc;
      if (s.far === mesh) return s.farOcc;
    }
    return null;
  }

  get drawMeshes(): number {
    let n = 0;
    for (const s of this.sets.values()) n += 2 + (s.glowNear ? 2 : 0);
    return n;
  }
}
