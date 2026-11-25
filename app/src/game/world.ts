/**
 * World model: one continuous land under one continuous climate, opened tile by tile.
 *
 * Nothing about the terrain is laid out per tile. A continent field says where the
 * land is, a climate field (temperature with a northward gradient, moisture,
 * volcanic activity, mountain ranges) says what the land is like, and both run on
 * unbroken across the whole world. Ground colour, relief and vegetation follow the
 * climate with wide gradients, so forest thins into grassland and grassland into
 * desert instead of meeting them at a line.
 *
 * The 40 BU tiles are only the planning lattice: a tile that has not been opened
 * yet is hidden sea, and opening one lets the land that was always there rise from
 * the mist. A region card may steer its tile towards a biome of its own; that
 * steering is strongest at the tile's centre and fades to nothing at its edges.
 *
 * This is the ONLY implementation of the height and ground-colour functions.
 * The browser samples it for collision, the map, the terrain meshes, and the
 * offline Blender terrain export is built from the very same numbers.
 */
import { Perlin2, fbm, smoothstep, lerp, clamp01 } from '../lib/noise';
import { BIOMES, BiomeDef, PropRule, TileFeature, BiomeWeights } from './biomes';
import type { ModelEntry } from './assets';

export type BiomeId = 'meadow' | 'forest' | 'snow' | 'desert' | 'swamp' | 'volcanic' | 'beach' | 'ocean';

export const TILE = 40; // world units per tile
export const CHUNK = 10; // terrain chunk edge
export const SUBDIV = 14; // height samples per chunk edge
export const SEA = 0;
/** BU beyond the frontier over which the land that is not opened yet falls away into sea */
const EDGE_BAND = 14;
/** how far a steered tile's own climate reaches: full inside this share of the half tile, gone at its edge */
const STEER_CORE = 0.42;

export interface WorldSettings {
  seed: number;
}

export const DEFAULT_WORLD: WorldSettings = { seed: 20261121 };

export function worldWithSeed(seed: number): WorldSettings {
  return { seed: seed | 0 };
}

/** A tile as it is authored: by the birth block, an AI region card, or the local recipe. */
export interface TileSpec {
  x: number;
  z: number;
  /** biome the region is steered towards; absent = the climate here decides */
  biome?: BiomeId;
  name?: string;
  peak?: number;
  rough?: number;
  /** share of the tile that is land, when the card asks for one */
  land?: number;
  feature?: TileFeature;
  /** width of the causeway, when a bridge is given */
  bridgeWidth?: number;
  /** '#rrggbb' — a gentle hue cast on the ground palette */
  accent?: string;
  /** the tile's whole vegetation, when a card lists it (older saves); absent = the climate decides */
  props?: PropRule[];
  /** what a region's card adds on top of what the climate grows: landmarks, new models, the things a wish asked for */
  extra?: PropRule[];
  source?: 'preset' | 'ai' | 'local';
  provider?: string;
  model?: string;
  mood?: string;
  desc?: string;
  /** the AI asked Blender to build new models for this tile */
  blender?: boolean;
  newModels?: string[];
  /** those models and where they are served from — kept in the save so a reload brings them back */
  built?: ModelEntry[];
  /** a sand causeway from (ax, az) to (bx, bz) that makes an island tile walkable */
  bridge?: { ax: number; az: number; bx: number; bz: number };
  /** how many tiles this country needs (a ridge, a ring of reef), 1–3; the browser opens the rest */
  extent?: number;
  /** the card's reason, when it asked for more than one tile */
  extentWhy?: string;
}

export interface Bridge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
}

export interface TileFeatureSpec {
  type: TileFeature;
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface TileState {
  key: number;
  x: number;
  z: number;
  /** the biome the tile is steered towards, else the one its climate gives at its centre */
  biome: BiomeId;
  def: BiomeDef;
  /** the name on its card, else the name of its biome */
  name: string;
  /** typical values over the tile, for the HUD, the map and the AI's context */
  peak: number;
  rough: number;
  land: number;
  feature: TileFeatureSpec | null;
  tint: [number, number, number];
  /** props asked for by the tile's card; null = the species table follows the climate */
  props: PropRule[] | null;
  spec: TileSpec;
  bridge: Bridge | null;
}

export interface FrontierTile {
  key: number;
  x: number;
  z: number;
  /** generated neighbours and the midpoint of the border shared with each */
  touches: { x: number; z: number; midX: number; midZ: number }[];
}

export interface SavedWorld {
  /** 3: the continuous climate world. Saves from the tiled world (2) are left alone and replaced. */
  v: 3;
  seed: number;
  tiles: TileSpec[];
}

export const tileKey = (x: number, z: number) => (x + 512) * 4096 + (z + 512);
export const chunkKey = (x: number, z: number) => (x + 512) * 4096 + (z + 512);
/** tile whose centre is nearest to a world position */
export const tileOf = (x: number, z: number): [number, number] => [Math.round(x / TILE), Math.round(z / TILE)];

// --------------------------------------------------------------------------- fields

/** The land signal before any tile is opened: what the mist hides is already decided here. */
function landSignal(cont: Perlin2, shelf: Perlin2, coast: Perlin2, x: number, z: number): number {
  const c = coast.noise(x * 0.024 + 3.1, z * 0.024 - 1.7) + coast.noise(x * 0.06 - 7.3, z * 0.06 + 4.9) * 0.26;
  return fbm(cont, x * 0.004 + 11.3, z * 0.004 - 5.1, 3) + fbm(shelf, x * 0.013 - 3.7, z * 0.013 + 8.2, 2) * 0.3 + c * 0.3 - 0.1;
}

/**
 * Where in the world this seed's island lies. Every seed is its own world: the
 * search looks for a spot that is solid land in the middle with sea on most of a
 * ring around it — an island with coasts to walk — and takes the first among equals,
 * so the same seed always gives the same island and a new seed a different one.
 */
function findOrigin(seed: number): { x: number; z: number } {
  const cont = new Perlin2(seed + 911);
  const shelf = new Perlin2(seed + 313);
  const coast = new Perlin2(seed + 401);
  const volcan = new Perlin2(seed + 577);
  const mountN = new Perlin2(seed + 839);
  let bx = 0;
  let bz = 0;
  let best = -Infinity;
  // if no spot has a proper coast, the one with the most sea around it will have to do
  let fx = 0;
  let fz = 0;
  let fallback = -1;
  const STEP = 19.1;
  for (let j = -24; j <= 24; j++) {
    for (let i = -24; i <= 24; i++) {
      const ox = i * STEP;
      const oz = j * STEP;
      // the middle of the island: dry ground all through the core of the birth block
      let lowest = Infinity;
      for (let a = -2; a <= 2; a++) {
        for (let b = -2; b <= 2; b++) {
          const v = landSignal(cont, shelf, coast, ox + a * 9, oz + b * 9);
          if (v < lowest) lowest = v;
        }
      }
      if (lowest < 0.05) continue;
      // a volcano or a mountain range under the spawn is a rough place to wake up on
      const harsh =
        smoothstep(0.3, 0.5, volcan.noise(ox * 0.0105 + 17.2, oz * 0.0105 + 6.4)) +
        smoothstep(0.35, 0.6, fbm(mountN, ox * 0.0055 - 21.5, oz * 0.0055 + 3.3, 2));
      // the coast: sea on most of a ring a little inside the birth block's edge, so
      // the island reads as an island; whatever lies further out is other isles
      let sea = 0;
      let far = 0;
      const N = 72;
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        if (landSignal(cont, shelf, coast, ox + Math.cos(a) * 41, oz + Math.sin(a) * 41) < 0) sea++;
        if (landSignal(cont, shelf, coast, ox + Math.cos(a) * 76, oz + Math.sin(a) * 76) < 0) far++;
      }
      const seaShare = sea / N;
      if (seaShare > fallback) {
        fallback = seaShare;
        fx = ox;
        fz = oz;
      }
      if (seaShare < 0.42 || harsh > 0.5) continue;
      const score = seaShare * 2 + (far / N) * 0.6 - harsh * 1.5 - lowest * 0.3 - (Math.abs(i) + Math.abs(j)) * 0.003;
      if (score > best) {
        best = score;
        bx = ox;
        bz = oz;
      }
    }
  }
  return best === -Infinity ? { x: fx, z: fz } : { x: bx, z: bz };
}

/** 1 inside a tile's own ground, falling smoothly to 0 over EDGE_BAND beyond its edge. */
function coverage(x: number, z: number, t: TileState): number {
  const dx = Math.abs(x - t.x * TILE) - TILE * 0.5;
  const dz = Math.abs(z - t.z * TILE) - TILE * 0.5;
  const d = Math.max(dx, dz);
  if (d <= 0) return 1;
  if (d >= EDGE_BAND) return 0;
  return 1 - smoothstep(0, EDGE_BAND, d);
}

/** How much of its own climate a steered tile asserts at a point: 1 at its centre, 0 at its edge. */
function steerWeight(x: number, z: number, t: TileState): number {
  const r = Math.max(Math.abs(x - t.x * TILE), Math.abs(z - t.z * TILE)) / (TILE * 0.5);
  return 1 - smoothstep(STEER_CORE, 1, r);
}

// --------------------------------------------------------------------------- colour helpers

const s2l = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export function hexLin(hex: number): [number, number, number] {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}
function hexStrLin(hex: string): number[] {
  return hexLin(parseInt(hex.replace('#', ''), 16));
}
const mix3 = (a: number[], b: number[], t: number, out: Float64Array) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};
const blend3 = (out: Float64Array, b: number[], t: number) => {
  out[0] += (b[0] - out[0]) * t;
  out[1] += (b[1] - out[1]) * t;
  out[2] += (b[2] - out[2]) * t;
};

interface LinearPalette {
  shore: number[];
  wet: number[];
  low: number[];
  mid: number[];
  high: number[];
  rock: number[];
  deep: number[];
  mapLow: number[];
  mapHigh: number[];
  mapShore: number[];
}

const LIN = new Map<BiomeId, LinearPalette>();
function lin(b: BiomeDef): LinearPalette {
  let p = LIN.get(b.id);
  if (!p) {
    p = {
      shore: hexLin(b.ground.shore), wet: hexLin(b.ground.wet), low: hexLin(b.ground.low), mid: hexLin(b.ground.mid),
      high: hexLin(b.ground.high), rock: hexLin(b.ground.rock), deep: hexLin(b.ground.deep),
      mapLow: hexLin(b.map.low), mapHigh: hexLin(b.map.high), mapShore: hexStrLin(b.map.shore),
    };
    LIN.set(b.id, p);
  }
  return p;
}
const SNOW = hexLin(0xfbfdff);
const SEA_FLOOR = hexLin(0xd9cf9f);
const SEA_FLOOR_DEEP = hexLin(0x6f8a86);
/** one water colour for the whole map: water does not change with the biome it touches */
const MAP_SHALLOW = hexLin(0xbdeee6);
const MAP_DEEP = hexLin(0x74bfd2);
const MAP_SHORE = hexLin(0xf3ecdc);

/** '#rrggbb' -> a subtle multiplicative tint (white = no cast) */
function accentTint(hex: string | undefined): [number, number, number] {
  if (!hex) return [1, 1, 1];
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const c = hexLin(parseInt(m[1], 16));
  return [1 + (c[0] - 0.6) * 0.3, 1 + (c[1] - 0.6) * 0.3, 1 + (c[2] - 0.6) * 0.3];
}

// --------------------------------------------------------------------------- field

export class IslandField {
  readonly tiles = new Map<number, TileState>();
  readonly settings: WorldSettings;
  /** where in the continent and climate fields this world's island lies */
  readonly origin: { x: number; z: number };
  /** bumps by one every time the tile set changes (terrain, shore and mist must be rebuilt) */
  version = 0;

  private cont: Perlin2;
  private shelf: Perlin2;
  private tempN: Perlin2;
  private moistN: Perlin2;
  private volcanN: Perlin2;
  private mountN: Perlin2;
  private coast: Perlin2;
  private detail: Perlin2;
  private hill: Perlin2;
  private patch: Perlin2;
  /** heights exported from the Blender terrain project (chunk key -> (SUBDIV+1)^2 samples) */
  private overrides = new Map<number, Float32Array>();
  /** sand causeways that keep every generated tile reachable on foot */
  private bridges: Bridge[] = [];
  private _frontier: FrontierTile[] | null = null;
  private _col = new Float64Array(3);

  // scratch filled by sample(): everything the height and the colour of one point need
  private _sx = NaN;
  private _sz = NaN;
  private _n = 0;
  private _tiles: (TileState | null)[] = [null, null, null, null];
  private _w = new Float64Array(4);
  private _mask = 0;
  private _pot = 0;
  private _temp = 0;
  private _moist = 0;
  private _peak = 0;
  private _rough = 0;
  private _ridge = 0;
  private _terrace = 0;
  private _dune = 0;
  private _pool = 0;
  private _wB: BiomeWeights = { snow: 0, desert: 0, swamp: 0, forest: 0, meadow: 0, volcanic: 0, taiga: 0 };

  constructor(settings: WorldSettings, birth = true) {
    this.settings = settings;
    const s = settings.seed;
    this.cont = new Perlin2(s + 911);
    this.shelf = new Perlin2(s + 313);
    this.tempN = new Perlin2(s + 149);
    this.moistN = new Perlin2(s + 233);
    this.volcanN = new Perlin2(s + 577);
    this.mountN = new Perlin2(s + 839);
    this.coast = new Perlin2(s + 401);
    this.detail = new Perlin2(s + 101);
    this.hill = new Perlin2(s + 977);
    this.patch = new Perlin2(s + 71);
    this.origin = findOrigin(s);
    if (birth) {
      // the island the player wakes up on: nine tiles, shaped by nothing but the fields
      for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) this.addTile({ x, z, source: 'preset' }, false);
      this.touch();
    }
  }

  /** bumps the version: terrain, shore and mist must be rebuilt */
  touch() {
    this.version++;
    this._frontier = null;
  }

  /** Registers a tile. Re-adding the same key replaces it. */
  addTile(spec: TileSpec, bump = true): TileState {
    const steer = spec.biome && spec.biome in BIOMES ? spec.biome : null;
    const def = BIOMES[steer ?? 'meadow'];
    const key = tileKey(spec.x, spec.z);
    let feature: TileFeatureSpec | null = null;
    const type = spec.feature ?? (steer ? def.feature : 'none');
    if (type !== 'none') {
      const rnd = ((key * 2654435761) >>> 0) / 4294967296;
      const a = rnd * Math.PI * 2;
      const off = 4.5;
      const cx = spec.x * TILE + Math.cos(a) * off;
      const cz = spec.z * TILE + Math.sin(a) * off;
      if (type === 'volcano') feature = { type, x: cx, z: cz, r: 16.5, h: 15 + (spec.peak ?? def.peak) * 0.5 };
      else if (type === 'peak') feature = { type, x: cx, z: cz, r: 9.5, h: 12 + (spec.peak ?? def.peak) * 0.4 };
      else if (type === 'crater') feature = { type, x: cx, z: cz, r: 9, h: 4.5 };
      else feature = { type, x: cx, z: cz, r: 8, h: 2.6 };
    }
    const t: TileState = {
      key,
      x: spec.x,
      z: spec.z,
      biome: steer ?? 'meadow',
      def,
      name: spec.name?.trim() || def.label,
      peak: spec.peak ?? def.peak,
      rough: spec.rough ?? def.rough,
      land: spec.land ?? def.land,
      feature,
      tint: accentTint(spec.accent),
      props: spec.props && spec.props.length ? spec.props : null,
      spec,
      bridge: null,
    };
    const br = spec.bridge;
    if (br) t.bridge = { ax: br.ax, az: br.az, bx: br.bx, bz: br.bz, width: spec.bridgeWidth ?? 9 };
    this.tiles.set(key, t);
    this.bridges = [...this.tiles.values()].filter((x) => x.bridge).map((x) => x.bridge as Bridge);
    this.summarize(t, steer);
    if (bump) this.touch();
    return t;
  }

  /**
   * Takes the tile's measure: the biome its climate gives (unless a card steered
   * it), and typical relief, roughness and land share for the HUD and the AI.
   */
  private summarize(t: TileState, steer: BiomeId | null): void {
    const N = 7;
    let peak = 0;
    let rough = 0;
    let land = 0;
    const votes = new Map<BiomeId, number>();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = t.x * TILE + ((i + 0.5) / N - 0.5) * TILE;
        const z = t.z * TILE + ((j + 0.5) / N - 0.5) * TILE;
        const h = this.height(x, z);
        peak += this._peak;
        rough += this._rough;
        if (h >= 0.3) land++;
        const b = h < 0.3 ? 'ocean' : this.biomeOf(this._wB);
        votes.set(b, (votes.get(b) ?? 0) + 1);
      }
    }
    const n = N * N;
    t.peak = peak / n;
    t.rough = rough / n;
    t.land = land / n;
    if (!steer) {
      let best: BiomeId = 'meadow';
      let bn = -1;
      for (const [b, k] of votes) {
        if (k > bn) {
          bn = k;
          best = b;
        }
      }
      t.biome = best;
      t.def = BIOMES[best];
      t.name = t.spec.name?.trim() || t.def.label;
    }
  }

  /** The biome a set of weights adds up to. */
  biomeOf(w: BiomeWeights): BiomeId {
    if (w.volcanic > 0.55) return 'volcanic';
    let best: BiomeId = 'meadow';
    let bn = w.meadow;
    if (w.forest > bn) (best = 'forest'), (bn = w.forest);
    if (w.snow > bn) (best = 'snow'), (bn = w.snow);
    if (w.desert > bn) (best = 'desert'), (bn = w.desert);
    if (w.swamp > bn) (best = 'swamp');
    return best;
  }

  clear() {
    this.tiles.clear();
    this.bridges = [];
    this.overrides.clear();
    this.touch();
  }

  get(tile: number, z: number): TileState | undefined {
    return this.tiles.get(tileKey(tile, z));
  }

  list(): TileState[] {
    return [...this.tiles.values()];
  }

  /** Lava pool in a volcano crater: where the crater floor dips below the melt line. */
  lavaPool(t: TileState): { x: number; z: number; y: number; r: number } | null {
    const f = t.feature;
    if (!f || f.type !== 'volcano') return null;
    const rim = this.height(f.x + f.r * 0.3, f.z);
    return { x: f.x, z: f.z, y: rim - f.h * 0.27, r: f.r * 0.2 };
  }

  /** Heights exported from the Blender terrain project take over the analytic field. */
  setHeights(cx: number, cz: number, grid: Float32Array) {
    this.overrides.set(chunkKey(cx, cz), grid);
  }

  clearOverrides() {
    this.overrides.clear();
  }

  /** Drops the exported heights of one chunk (its ground has since changed). */
  clearHeights(cx: number, cz: number) {
    this.overrides.delete(chunkKey(cx, cz));
  }

  // ------------------------------------------------------------------ sampling

  /**
   * Fills the scratch fields for one point: which steered tiles reach it, the land
   * signal, and the climate with everything derived from it. A repeated call for
   * the same point is free, so height() and groundColor() share one pass.
   */
  private sample(x: number, z: number, opened = true): void {
    if (opened && x === this._sx && z === this._sz) return;
    if (opened) {
      this._sx = x;
      this._sz = z;
    } else {
      this._sx = NaN; // a look past the mist must not be mistaken for the place itself
    }

    const fx = x / TILE;
    const fz = z / TILE;
    const tx = Math.round(fx);
    const tz = Math.round(fz);
    const bx = fx - tx >= 0 ? tx + 1 : tx - 1;
    const bz = fz - tz >= 0 ? tz + 1 : tz - 1;
    let n = 0;
    let mask = 0;
    const take = (cx: number, cz: number) => {
      const t = this.tiles.get(tileKey(cx, cz));
      if (!t) return;
      const m = coverage(x, z, t);
      if (m > mask) mask = m;
      // only a tile that asks for something of its own has to be blended in
      if (t.spec.biome !== undefined || t.spec.peak !== undefined || t.spec.rough !== undefined || t.spec.land !== undefined) {
        const w = steerWeight(x, z, t);
        if (w > 1e-4) {
          this._tiles[n] = t;
          this._w[n] = w;
          n++;
        }
      }
    };
    take(tx, tz);
    take(bx, tz);
    take(tx, bz);
    take(bx, bz);
    this._n = n;

    // the island's spot in the fields: world (0, 0) is the place findOrigin() chose
    const gx = x + this.origin.x;
    const gz = z + this.origin.z;
    // land that is not opened yet is sea: the signal drops steeply past the frontier
    let pot = landSignal(this.cont, this.shelf, this.coast, gx, gz) - (opened ? (1 - mask) * 3 : 0);
    // the fields change slowly: steepen their edges, so a coast is a beach a few
    // paces wide, the relief starts within sight of it, and the floor drops away
    // into water you can swim in instead of lying as a wet sand flat for 30 BU
    pot *= 2.3;

    // colder to the north: the gradient is measured from the spawn, in world space
    let temp = clamp01(0.5 + 0.46 * fbm(this.tempN, gx * 0.0056 + 31.7, gz * 0.0056 - 12.9, 2) + z * 0.0023);
    let moist = clamp01(0.47 + 0.62 * fbm(this.moistN, gx * 0.005 - 8.3, gz * 0.005 + 44.1, 2));
    let volc = smoothstep(0.44, 0.62, this.volcanN.noise(gx * 0.0105 + 17.2, gz * 0.0105 + 6.4));
    const mount = smoothstep(0.22, 0.52, fbm(this.mountN, gx * 0.0055 - 21.5, gz * 0.0055 + 3.3, 2));
    for (let i = 0; i < n; i++) {
      const t = this._tiles[i]!;
      const w = this._w[i];
      if (t.spec.biome !== undefined) {
        temp = lerp(temp, t.def.temp, w);
        moist = lerp(moist, t.def.moist, w);
        volc = t.spec.biome === 'volcanic' ? lerp(volc, 1, w) : lerp(volc, 0, w * 0.8);
      }
      if (t.spec.land !== undefined) pot += (t.spec.land - 0.72) * 2.4 * w;
    }

    // the climate's parts: each share is taken out of what the colder or drier ones left
    const wB = this._wB;
    const cold = smoothstep(0.42, 0.2, temp);
    const dry = smoothstep(0.4, 0.2, moist) * smoothstep(0.55, 0.75, temp);
    const lowland = 1 - smoothstep(0.14, 0.5, Math.max(0, pot));
    const fen = smoothstep(0.7, 0.9, moist) * smoothstep(0.38, 0.58, temp) * lowland;
    const wooded = smoothstep(0.5, 0.66, moist);
    wB.snow = cold;
    wB.desert = (1 - cold) * dry;
    wB.swamp = (1 - cold) * (1 - dry) * fen;
    wB.forest = (1 - cold) * (1 - dry) * (1 - fen) * wooded;
    wB.meadow = (1 - cold) * (1 - dry) * (1 - fen) * (1 - wooded);
    wB.volcanic = volc;
    wB.taiga = smoothstep(0.5, 0.3, temp) * (1 - dry * 0.75);

    let peak =
      6 * wB.meadow + 9 * wB.forest + 14 * wB.snow + 6.5 * wB.desert + 2.4 * wB.swamp + 8 * wB.volcanic +
      mount * (7 + 6 * (1 - wB.swamp) * (1 - wB.desert));
    let rough = 0.3 * wB.meadow + 0.42 * wB.forest + 0.55 * wB.snow + 0.3 * wB.desert + 0.3 * wB.swamp + 0.65 * wB.volcanic + mount * 0.12;
    for (let i = 0; i < n; i++) {
      const t = this._tiles[i]!;
      const w = this._w[i];
      if (t.spec.peak !== undefined) peak = lerp(peak, t.spec.peak, w);
      if (t.spec.rough !== undefined) rough = lerp(rough, t.spec.rough, w);
    }

    this._mask = mask;
    this._pot = pot;
    this._temp = temp;
    this._moist = moist;
    this._peak = peak;
    this._rough = rough;
    this._ridge = clamp01(wB.snow * 0.7 + mount * 0.75);
    this._terrace = clamp01(wB.desert * 0.55 + volc * 0.5);
    this._dune = wB.desert;
    this._pool = wB.swamp;
  }

  /** Low-frequency patch noise (-1..1): where drifts of ground cover grow. */
  patchNoise(x: number, z: number): number {
    return this.patch.noise(x * 0.05 + 9.1, z * 0.05 - 4.4);
  }

  /**
   * Three octaves of noise (-1..1) from clump to leaf: on the map, ground that
   * carries plants is mottled with it so it reads as canopy at any zoom.
   */
  canopyNoise(x: number, z: number): number {
    return this.detail.noise(x * 0.21 + 5.3, z * 0.21 - 8.8) * 0.5 + this.detail.noise(x * 0.63 - 2.1, z * 0.63 + 4.4) * 0.3 + (1 - 2 * Math.abs(this.detail.noise(x * 1.7 + 7.7, z * 1.7 + 1.2))) * 0.2;
  }

  /** Two octaves of noise (-1..1) at the scale of a few paces: the ragged edge of the map's fog follows it. */
  edgeNoise(x: number, z: number): number {
    return this.patch.noise(x * 0.083 + 13.7, z * 0.083 - 6.1) * 0.65 + this.patch.noise(x * 0.237 - 4.4, z * 0.237 + 9.3) * 0.35;
  }

  /**
   * What a place will be like once its tile is opened — the mist hides it, but the
   * land and the climate are already decided. Used for the frontier tiles the AI
   * is asked to design.
   */
  outlook(x: number, z: number): { temp: number; moist: number; biome: BiomeId; land: boolean; peak: number } {
    this.sample(x, z, false);
    const land = this._pot > 0;
    // the sea is the sea, whatever the climate over it would grow on land
    return { temp: this._temp, moist: this._moist, biome: land ? this.biomeOf(this._wB) : 'ocean', land, peak: this._peak };
  }

  /** Temperature and moisture at a point (each 0..1), after whatever a steered tile adds. */
  climate(x: number, z: number, out: [number, number]): [number, number] {
    this.sample(x, z);
    out[0] = this._temp;
    out[1] = this._moist;
    return out;
  }

  /** The biome weights at a point, for a species niche. */
  weights(x: number, z: number, out: BiomeWeights): BiomeWeights {
    this.sample(x, z);
    const w = this._wB;
    out.snow = w.snow;
    out.desert = w.desert;
    out.swamp = w.swamp;
    out.forest = w.forest;
    out.meadow = w.meadow;
    out.volcanic = w.volcanic;
    out.taiga = w.taiga;
    return out;
  }

  /** Biome at a point: climate on land, the sea's own names in the water. */
  biomeAt(x: number, z: number): BiomeId {
    const h = this.height(x, z);
    this.sample(x, z); // a Blender height returns before the climate is sampled
    if (h < 0.3) return h > -1.2 ? 'beach' : 'ocean';
    return this.biomeOf(this._wB);
  }

  // ------------------------------------------------------------------ height

  /** Height in BU. Sea level is 0. */
  height(x: number, z: number): number {
    if (this.overrides.size) {
      const cx = Math.floor(x / CHUNK);
      const cz = Math.floor(z / CHUNK);
      const g = this.overrides.get(chunkKey(cx, cz));
      if (g) {
        const step = CHUNK / SUBDIV;
        const gx = (x - cx * CHUNK) / step;
        const gz = (z - cz * CHUNK) / step;
        const ix = Math.max(0, Math.min(SUBDIV - 1, Math.floor(gx)));
        const iz = Math.max(0, Math.min(SUBDIV - 1, Math.floor(gz)));
        const fx = Math.min(1, Math.max(0, gx - ix));
        const fz = Math.min(1, Math.max(0, gz - iz));
        const n = SUBDIV + 1;
        const h00 = g[iz * n + ix];
        const h10 = g[iz * n + ix + 1];
        const h01 = g[(iz + 1) * n + ix];
        const h11 = g[(iz + 1) * n + ix + 1];
        return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
      }
    }

    this.sample(x, z);
    const pot = this._pot;
    const n = this._n;
    const n2 = this.detail.noise(x * 0.052, z * 0.052) * 0.62 + this.detail.noise(x * 0.104, z * 0.104) * 0.28;
    // the floor: ankle-deep for a few paces, swimming depth within a dozen, then the deep
    const seaD = smoothstep(0, 1.3, -pot);
    const seaH = -(0.08 + 9.4 * Math.pow(seaD, 1.15)) + n2 * 0.25 * (1 - seaD * 0.6);
    if (pot < -1.3) return -9.48 + n2 * 0.1;

    const n1 = fbm(this.hill, x * 0.016 + 4.4, z * 0.016 - 2.8, 4);
    let h01 = n1 * 0.5 + 0.5;
    // knife-edge crests instead of round hills
    if (this._ridge > 0) {
      const r = Math.pow(clamp01((1 - Math.abs(n1)) * 1.3 - 0.14), 1.7);
      h01 = lerp(h01, r, this._ridge);
    }
    // stepped mesas: the hill is snapped onto a few wide terraces
    if (this._terrace > 0) {
      const k = 3.2;
      const q = h01 * k;
      const tq = (Math.floor(q) + smoothstep(0.55, 0.9, q - Math.floor(q))) / k;
      h01 = lerp(h01, tq, this._terrace);
    }
    // wind ripples across the dunes, warped so they are never parallel stripes
    let extra = 0;
    if (this._dune > 0) {
      const ph = (x * 0.82 + z * 0.57) * 0.6 + this.detail.noise(x * 0.03, z * 0.03) * 2.6;
      extra += this._dune * (0.5 + 0.5 * Math.sin(ph)) * 1.25;
    }
    let relief = this._peak * Math.pow(h01, 1.25) * 1.15 + n2 * (0.7 + this._rough * 2.0) + extra;
    // a fen barely rises above the tide: broad hollows drop below it and fill with water
    if (this._pool > 0) relief = lerp(relief, 0.25 + n1 * 1.9 + n2 * 1.1, this._pool);
    // volcanic ground heaps itself up into cones
    const v = this._wB.volcanic;
    if (v > 0.02) relief += v * v * (4.5 + 5 * Math.pow(h01, 2.2));
    // features of a steered tile (a volcano cone, a peak, a crater, a pond), faded in by its reach
    for (let i = 0; i < n; i++) {
      const t = this._tiles[i]!;
      const ft = t.feature;
      if (!ft) continue;
      const d = Math.hypot(x - ft.x, z - ft.z) / ft.r;
      if (d >= 1.25) continue;
      const w = this._w[i];
      if (ft.type === 'volcano') {
        const flank = Math.pow(smoothstep(1.25, 0.3, d), 1.15);
        const bowl = smoothstep(0.3, 0.1, d) * smoothstep(0.3, 0.24, d);
        relief += w * ft.h * (flank - 0.42 * bowl);
      } else if (ft.type === 'peak') {
        relief += w * ft.h * Math.pow(smoothstep(1.25, 0, d), 1.6);
      } else if (ft.type === 'crater') {
        relief += w * ft.h * (smoothstep(1.25, 0.55, d) - 1.35 * smoothstep(0.5, 0.15, d));
      } else {
        relief -= w * ft.h * smoothstep(1.1, 0.2, d);
      }
    }

    // the shore zone stays low and flat; the relief only climbs inland. The land
    // starts at the waterline with no step, so a beach runs smoothly into the water
    const landT = smoothstep(0, 0.3, pot);
    const inland = smoothstep(0.1, 0.95, pot);
    const landH = 1.3 * landT + relief * inland + this.detail.noise(x * 0.09, z * 0.09) * 0.07 * landT;
    let out = lerp(seaH, landH, smoothstep(-0.012, 0.03, pot));

    // sand causeways: a low bank just above the tide, with a shallow shelf around
    // it, joining an otherwise unreachable tile to the walked one
    for (const br of this.bridges) {
      const dx = br.bx - br.ax;
      const dz = br.bz - br.az;
      const l2 = dx * dx + dz * dz || 1;
      let u = ((x - br.ax) * dx + (z - br.az) * dz) / l2;
      if (u < -0.12 || u > 1.12) continue;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(x - (br.ax + dx * u), z - (br.az + dz * u));
      const half = br.width * 0.5 * (1 + 0.22 * Math.sin(u * 7 + br.ax * 0.37));
      const reach = half + 4;
      if (d >= reach) continue;
      const across = 1 - smoothstep(half * 0.4, reach, d);
      out = smoothMax(out, lerp(-0.6, 1.2, across), 1.2);
    }
    return out;
  }

  /** Approximate slope 0..1 from finite differences — used for shading & placement. */
  slope(x: number, z: number): number {
    const d = 0.9;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    return Math.min(1, (Math.hypot(hx, hz) / (2 * d)) * 0.9);
  }

  normal(x: number, z: number, out?: [number, number, number]): [number, number, number] {
    const d = 0.7;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    const nx = -hx;
    const nz = -hz;
    const ny = 2 * d;
    const len = Math.hypot(nx, ny, nz) || 1;
    const o = out ?? [0, 0, 0];
    o[0] = nx / len;
    o[1] = ny / len;
    o[2] = nz / len;
    return o;
  }

  /** True when a position is walkable land above the tide line. */
  isLand(x: number, z: number, minH = 0.35): boolean {
    return this.height(x, z) >= minH;
  }

  // ------------------------------------------------------------------ colour

  private biomeColor(def: BiomeDef, h: number, slope: number, pn: number, fine: number, out: Float64Array) {
    const p = lin(def);
    if (h < 0.03) {
      mix3(p.shore, p.deep, clamp01(-h / 3.2), out);
    } else {
      const beachH = def.beachH;
      const band = h + pn * 0.9 + fine * 0.12;
      mix3(p.shore, p.low, smoothstep(beachH * 0.5, beachH * 1.5, band), out);
      const t1 = smoothstep(2.4, 5.2, band);
      if (t1 > 0) blend3(out, p.mid, t1);
      const t2 = smoothstep(6.4, 10.6, band);
      if (t2 > 0) blend3(out, p.high, t2);
      if (def.snowline < 50) {
        const ts = smoothstep(def.snowline - 0.5, def.snowline + 1.2, band);
        if (ts > 0) blend3(out, SNOW, ts);
      }
      const wet = 1 - smoothstep(0.06, 0.5, h);
      if (wet > 0) blend3(out, p.wet, wet * 0.8);
    }
    const rockT = smoothstep(0.5, 0.74, slope);
    if (rockT > 0) blend3(out, p.rock, rockT * 0.92);
  }

  /** Linear rgb of the ground surface at a point. */
  groundColor(x: number, z: number, h: number, ny: number, out: Float32Array): Float32Array {
    this.sample(x, z);
    const n = this._n;
    if (this._mask < 0.004) {
      // past every opened tile: bare sea floor
      const t = clamp01(-h / 5);
      out[0] = SEA_FLOOR[0] + (SEA_FLOOR_DEEP[0] - SEA_FLOOR[0]) * t;
      out[1] = SEA_FLOOR[1] + (SEA_FLOOR_DEEP[1] - SEA_FLOOR[1]) * t;
      out[2] = SEA_FLOOR[2] + (SEA_FLOOR_DEEP[2] - SEA_FLOOR[2]) * t;
      return out;
    }
    const slope = Math.sqrt(Math.max(0, 1 - ny * ny));
    const pn = this.patch.noise(x * 0.045 + 2.2, z * 0.045 - 1.3);
    const fine = this.patch.noise(x * 0.19 - 5.1, z * 0.19 + 3.7);
    const c = this._col;
    // each climate paints the ground its own way; the shares blend the results
    const w = this._wB;
    let r = 0;
    let g = 0;
    let b = 0;
    let ws = 0;
    const add = (def: BiomeDef, k: number) => {
      if (k <= 1e-4) return;
      this.biomeColor(def, h, slope, pn, fine, c);
      r += c[0] * k;
      g += c[1] * k;
      b += c[2] * k;
      ws += k;
    };
    // on the cold side the ground keeps the green of the pine country and whitens slowly
    const cold = w.snow;
    const white = cold * cold * (0.5 + 0.5 * cold);
    const green = 1 - cold;
    add(BIOMES.snow, white);
    add(BIOMES.desert, w.desert);
    add(BIOMES.swamp, w.swamp);
    add(BIOMES.forest, w.forest + cold * green * 0.62);
    add(BIOMES.meadow, w.meadow + cold * green * 0.38);
    if (ws > 1e-9) {
      r /= ws;
      g /= ws;
      b /= ws;
    }
    if (w.volcanic > 0.004) {
      this.biomeColor(BIOMES.volcanic, h, slope, pn, fine, c);
      r = lerp(r, c[0], w.volcanic);
      g = lerp(g, c[1], w.volcanic);
      b = lerp(b, c[2], w.volcanic);
    }
    // snow caps: high ground stays white wherever the year is cool
    const cap = smoothstep(0.66, 0.4, this._temp);
    if (cap > 0.01) {
      const ts = smoothstep(11.5, 14.5, h + pn * 0.8) * cap;
      if (ts > 0) {
        r = lerp(r, SNOW[0], ts);
        g = lerp(g, SNOW[1], ts);
        b = lerp(b, SNOW[2], ts);
      }
    }
    // the hue a card asked for, over the core of its tile
    for (let i = 0; i < n; i++) {
      const t = this._tiles[i]!;
      const k = this._w[i] * 0.5;
      if (k < 0.01) continue;
      r *= lerp(1, t.tint[0], k);
      g *= lerp(1, t.tint[1], k);
      b *= lerp(1, t.tint[2], k);
    }
    const k = 1 + fine * 0.045;
    out[0] = r * k;
    out[1] = g * k;
    out[2] = b * k;
    return out;
  }

  /** Linear rgb for the map: climate-blended land, depth-graded water. */
  mapColor(x: number, z: number, h: number, out: Float32Array): Float32Array {
    this.sample(x, z);
    const c = this._col;
    if (h < 0.2) {
      // land colour thins out under the water; the water's own colour deepens with the floor
      const shallow = clamp01(1 + h / 1.6);
      mix3(MAP_SHORE, MAP_SHALLOW, smoothstep(0, 1, shallow), c);
      // (a fraction of a negative number is not a number: only true depth counts)
      const deep = h < 0 ? clamp01(Math.pow(-h / 7, 0.7)) : 0;
      c[0] = lerp(c[0], MAP_DEEP[0], deep);
      c[1] = lerp(c[1], MAP_DEEP[1], deep);
      c[2] = lerp(c[2], MAP_DEEP[2], deep);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return out;
    }
    const w = this._wB;
    let r = 0;
    let g = 0;
    let b = 0;
    let ws = 0;
    const hi = clamp01((h - 1) / 9);
    const shoreT = smoothstep(0.2, 0.9, h);
    const add = (id: BiomeId, k: number) => {
      if (k <= 1e-4) return;
      const p = lin(BIOMES[id]);
      mix3(p.mapLow, p.mapHigh, hi, c);
      const sr = lerp(p.mapShore[0], c[0], shoreT);
      const sg = lerp(p.mapShore[1], c[1], shoreT);
      const sb = lerp(p.mapShore[2], c[2], shoreT);
      r += sr * k;
      g += sg * k;
      b += sb * k;
      ws += k;
    };
    const cold = w.snow;
    const white = cold * cold * (0.5 + 0.5 * cold);
    add('snow', white);
    add('desert', w.desert);
    add('swamp', w.swamp);
    add('forest', w.forest + cold * (1 - cold) * 0.62);
    add('meadow', w.meadow + cold * (1 - cold) * 0.38);
    if (ws > 1e-9) {
      r /= ws;
      g /= ws;
      b /= ws;
    }
    if (w.volcanic > 0.004) {
      const p = lin(BIOMES.volcanic);
      mix3(p.mapLow, p.mapHigh, hi, c);
      r = lerp(r, c[0], w.volcanic);
      g = lerp(g, c[1], w.volcanic);
      b = lerp(b, c[2], w.volcanic);
    }
    const cap = smoothstep(0.66, 0.4, this._temp);
    if (cap > 0.01) {
      const ts = smoothstep(11.5, 14.5, h) * cap;
      r = lerp(r, SNOW[0], ts);
      g = lerp(g, SNOW[1], ts);
      b = lerp(b, SNOW[2], ts);
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  /** HUD region name at a position: a card's name inside its tile, else the climate's. */
  regionName(x: number, z: number): string {
    const h = this.height(x, z);
    if (h < 0.3) {
      this.sample(x, z);
      return this._temp > 0.45 ? '碧礁浅海' : '寒雾海';
    }
    for (let i = 0; i < this._n; i++) {
      const t = this._tiles[i]!;
      if (this._w[i] > 0.5 && t.spec.name?.trim()) return t.spec.name.trim();
    }
    return BIOMES[this.biomeOf(this._wB)].label;
  }

  // ------------------------------------------------------------------ frontier

  /** Ungenerated tiles that share an edge with a generated one. */
  frontier(): FrontierTile[] {
    if (this._frontier) return this._frontier;
    const map = new Map<number, FrontierTile>();
    for (const t of this.tiles.values()) {
      const sides: [number, number][] = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      for (const [dx, dz] of sides) {
        const nx = t.x + dx;
        const nz = t.z + dz;
        const k = tileKey(nx, nz);
        if (this.tiles.has(k)) continue;
        let f = map.get(k);
        if (!f) {
          f = { key: k, x: nx, z: nz, touches: [] };
          map.set(k, f);
        }
        f.touches.push({ x: t.x, z: t.z, midX: (t.x + nx) * 0.5 * TILE, midZ: (t.z + nz) * 0.5 * TILE });
      }
    }
    this._frontier = [...map.values()];
    return this._frontier;
  }

  // ------------------------------------------------------------------ persistence

  toJSON(): SavedWorld {
    return { v: 3, seed: this.settings.seed, tiles: this.list().map((t) => t.spec) };
  }

  load(saved: SavedWorld | null | undefined): number {
    if (!saved || saved.v !== 3 || saved.seed !== this.settings.seed || !Array.isArray(saved.tiles)) return 0;
    this.clear();
    let n = 0;
    for (const s of saved.tiles) {
      if (!s || typeof s.x !== 'number' || typeof s.z !== 'number') continue;
      this.addTile(s, false);
      n++;
    }
    this.touch();
    return n;
  }
}

/** Soft maximum: like max() away from a tie, but rounds the crest where two landmasses meet. */
function smoothMax(a: number, b: number, k: number): number {
  const d = Math.abs(a - b);
  const h = Math.max(0, 1 - d / k);
  return Math.max(a, b) + (h * h * k) / 4;
}

/** Rectangle (in BU) covered by the generated tiles, plus a margin. */
export function tileBounds(tiles: TileState[], margin = 0): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.x);
    maxX = Math.max(maxX, t.x);
    minZ = Math.min(minZ, t.z);
    maxZ = Math.max(maxZ, t.z);
  }
  if (!tiles.length) return { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  const h = TILE * 0.5 + margin;
  return { minX: minX * TILE - h, maxX: maxX * TILE + h, minZ: minZ * TILE - h, maxZ: maxZ * TILE + h };
}

// --------------------------------------------------------------------------- reachability

/**
 * Flood-fills walkable ground (above the tide line) from a start point on a 2 BU
 * grid and reports which tiles contain reached cells. Cheap enough to run after
 * every generated region.
 */
export function reachableTiles(field: IslandField, sx: number, sz: number): { tiles: Set<number>; cells: Float32Array } {
  const b = tileBounds(field.list(), 4);
  const step = 2;
  const W = Math.ceil((b.maxX - b.minX) / step) + 1;
  const H = Math.ceil((b.maxZ - b.minZ) / step) + 1;
  const h = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) h[j * W + i] = field.height(b.minX + i * step, b.minZ + j * step);
  const seen = new Uint8Array(W * H);
  const cells: number[] = [];
  const i0 = Math.max(0, Math.min(W - 1, Math.round((sx - b.minX) / step)));
  const j0 = Math.max(0, Math.min(H - 1, Math.round((sz - b.minZ) / step)));
  // start from the nearest dry cell to the player
  let start = -1;
  for (let r = 0; r < 8 && start < 0; r++) {
    for (let dj = -r; dj <= r && start < 0; dj++) {
      for (let di = -r; di <= r && start < 0; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        if (h[j * W + i] > 0.34) start = j * W + i;
      }
    }
  }
  const tiles = new Set<number>();
  const stack = start >= 0 ? [start] : [];
  while (stack.length) {
    const c = stack.pop() as number;
    if (seen[c]) continue;
    seen[c] = 1;
    const i = c % W;
    const j = (c - i) / W;
    const x = b.minX + i * step;
    const z = b.minZ + j * step;
    cells.push(x, z);
    const t = field.get(...tileOf(x, z));
    if (t) tiles.add(t.key);
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = nj * W + ni;
      if (!seen[n] && h[n] > 0.34) stack.push(n);
    }
  }
  return { tiles, cells: new Float32Array(cells) };
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Makes sure every generated tile can be entered on foot from the start point:
 * any tile the flood fill never reaches is joined to the nearest reached ground
 * with a sand causeway. Returns how many causeways were added.
 */
export function connectTiles(field: IslandField, sx: number, sz: number): number {
  let added = 0;
  for (let pass = 0; pass < 3; pass++) {
    const reach = reachableTiles(field, sx, sz);
    const missing = field.list().filter((t) => !reach.tiles.has(t.key));
    if (!missing.length) break;
    for (const t of missing) {
      const cx = t.x * TILE;
      const cz = t.z * TILE;
      // the reached cell closest to the tile centre is where the causeway starts
      let bx = sx;
      let bz = sz;
      let best = Infinity;
      for (let k = 0; k + 1 < reach.cells.length; k += 2) {
        const d = Math.hypot(reach.cells[k] - cx, reach.cells[k + 1] - cz);
        if (d < best) {
          best = d;
          bx = reach.cells[k];
          bz = reach.cells[k + 1];
        }
      }
      const dx = cx - bx;
      const dz = cz - bz;
      const len = Math.hypot(dx, dz) || 1;
      // run from the shore the player can already stand on into the middle of the tile
      const ex = cx - (dx / len) * 9;
      const ez = cz - (dz / len) * 9;
      field.addTile({ ...t.spec, bridge: { ax: bx - (dx / len) * 3, az: bz - (dz / len) * 3, bx: ex, bz: ez } });
      added++;
    }
    field.touch();
  }
  return added;
}
