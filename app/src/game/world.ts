import { Perlin2, fbm, smoothstep, lerp, clamp01, mulberry32 } from '../lib/noise';

export const ISLAND_HALF = 50; // 100 BU island, centred on origin
export const CHUNK = 10;
export const GRID = 10; // chunks per axis
export const SEA = 0;

export interface WorldSettings {
  seed: number;
  peak: number;
  roughness: number;
  beachWidth: number;
  islandBias: number;
  palette: {
    sand: number;
    grass: number;
    rock: number;
    accent: number;
  };
}

export const DEFAULT_WORLD: WorldSettings = {
  seed: 20261121,
  peak: 16,
  roughness: 0.36,
  beachWidth: 5,
  islandBias: 0.05,
  palette: { sand: 0xdfcd9c, grass: 0x7fb96a, rock: 0x6f7e86, accent: 0x8fd6c2 },
};

/** A fresh world for the seed used by the settings "重置世界" action. */
export function worldWithSeed(seed: number): WorldSettings {
  return { ...DEFAULT_WORLD, seed: seed | 0 };
}

/** The single source of truth for terrain shape. Terrain mesh, water depth, map and collision all call this. */
/** A generative island added at runtime (E panel). Bumps rise out of the local sea. */
export interface RegionInstance {
  x: number;
  z: number;
  radius: number;
  height: number;
  phase: number;
  name: string;
  /**
   * Land bridge: a wide, flat saddle that fills the strait between the anchor on
   * the known shore and the dome centre. Without it the two landmasses touch at
   * a single point and read as two islands that happen to collide.
   */
  neck?: { ax: number; az: number; width: number; height: number };
}

/** Soft maximum: same as max() away from a tie, but rounds the crest where two
 *  landmasses meet, so a merged shore never shows a hard crease. */
function smoothMax(a: number, b: number, k = 1.2): number {
  const d = Math.abs(a - b);
  const h = Math.max(0, 1 - d / k);
  return Math.max(a, b) + h * h * k * 0.25;
}

export class IslandField {
  private base: Perlin2;
  private detail: Perlin2;
  private ridge: Perlin2;
  private warp: Perlin2;
  private readonly s: WorldSettings;
  /** islands generated after boot; the birth island is part of the base field */
  readonly regions: RegionInstance[] = [];

  constructor(settings: WorldSettings) {
    this.s = settings;
    this.base = new Perlin2(settings.seed);
    this.detail = new Perlin2(settings.seed + 101);
    this.ridge = new Perlin2(settings.seed + 977);
    this.warp = new Perlin2(settings.seed + 5531);
  }

  /** Registers a generated island. Returns its index. */
  addRegion(reg: RegionInstance): number {
    this.regions.push(reg);
    return this.regions.length - 1;
  }

  /** Signed distance-ish falloff from a deliberately irregular coastline. >0 land, <0 sea. */
  private coastField(x: number, z: number): number {
    const wx = this.warp.noise(x * 0.014 + 11.3, z * 0.014 - 4.7);
    const wz = this.warp.noise(x * 0.014 - 8.1, z * 0.014 + 6.2);
    const px = x + wx * 7.4;
    const pz = z + wz * 7.4;
    // A soft superellipse plus low-frequency lobes: broad bays, no stair-stepped outline.
    const nx = px / ISLAND_HALF;
    const nz = pz / ISLAND_HALF;
    const lobes =
      this.base.noise(px * 0.032, pz * 0.032) * 0.16 +
      this.base.noise(px * 0.074 + 3.1, pz * 0.074 - 7.9) * 0.07;
    const radius = Math.sqrt(nx * nx * 0.94 + nz * nz * 0.82);
    const spine = 1 - Math.abs(this.base.noise(px * 0.021 + 5.5, pz * 0.021 + 2.2)) * 0.2;
    return (1 - radius * spine) + lobes + this.s.islandBias * 0.18;
  }

  /** Height in BU. Sea level is 0; min ≈ -6 under water, max ≈ peak. */
  height(x: number, z: number): number {
    const c = this.coastField(x, z);
    const landMask = smoothstep(-0.06, 0.19, c);

    // rolling body
    const roll = fbm(this.base, x * 0.028, z * 0.028, 4) * 2.1;
    // designed hills: the fbm value is lifted into 0..1 and shaped — smooth fbm
    // instead of ridged noise, whose round concave pits read like craters.
    // pow must only ever see >=0 input: a negative fbm value would NaN the
    // whole height field (the island literally holes out).
    const hillRaw = fbm(this.ridge, x * 0.017 + 4.4, z * 0.017 - 2.8, 3);
    const hill = Math.pow(Math.max(0, hillRaw * 0.5 + 0.5), 1.35);
    const inland = smoothstep(0.04, 0.62, c);
    const relief = lerp(roll * 0.5, roll * 0.4 + hill * 11.5, inland);

    // gentle plateau in the middle of the isle so the player always has walkable ground
    const plateau = smoothstep(0.72, 0.1, Math.hypot(x, z) / ISLAND_HALF) * 1.5;
    // layered micro-relief: broad, gentle undulation only — high-frequency
    // bumps read as thresholds the character keeps tripping over, so the
    // detail octave runs at half the frequency and a third of the amplitude
    const micro = this.detail.noise(x * 0.05, z * 0.05) * 0.12;

    const h = 2.35 + relief + plateau + micro;
    const rugged = 0.82 + this.s.roughness * 0.5;
    const land = h * rugged * (0.82 + landMask * 0.34);

    // sea floor: shallow shelf near the coast, then drops away
    const shelf = smoothstep(-0.02, 0.42, -c);
    const floor = lerp(-0.55, -5.4, shelf) + this.detail.noise(x * 0.05, z * 0.05) * 0.55;

    let out = lerp(floor, Math.min(land * (this.s.peak / 17.5), this.s.peak), landMask);

    // Generated islands: a broad, SOFT dome merged into the existing ground with
    // a rounded crest (smoothMax), so the union reads as one landmass instead of
    // a second island pressed against the first with a visible seam.
    for (const reg of this.regions) {
      const dx = x - reg.x;
      const dz = z - reg.z;
      const d2 = dx * dx + dz * dz;
      const neckW = reg.neck ? reg.neck.width : 0;
      const reach = reg.radius * 1.5 + neckW + 14;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      const a = Math.atan2(dz, dx);
      // irregular coastline from the region phase
      const wob =
        0.82 +
        0.13 * Math.sin(a * 3 + reg.phase) +
        0.08 * Math.sin(a * 7 - reg.phase * 1.7) +
        0.05 * (this.base.noise(Math.cos(a) * 2.2 + reg.phase, Math.sin(a) * 2.2) - 0.5) * 2;
      const rr = reg.radius * wob;
      if (d <= rr) {
        const t = d / rr;
        // smooth dome: peak in the middle, gradual rise, small ridge variation.
        // The falloff is a gentle cosine shoulder (pow 0.72) so the rim flattens
        // out into a wide shelf that the neck can merge into.
        const fall = smoothstep(1.0, 0.1, t);
        const ridge = 0.9 + 0.1 * fbm(this.ridge, (x - reg.x) * 0.016 + reg.phase, (z - reg.z) * 0.016, 2);
        const dome = reg.height * Math.pow(fall, 0.72) * ridge;
        const base = Math.min(out, 0.4);
        out = smoothMax(out, base + dome, 2.6);
      }

      // ---- land bridge ----
      // A wide, FLAT causeway from the anchor on the known shore to the dome
      // shoulder. Two islands that merely touch at a point leave a steep-sided
      // channel with a seam running through it; filling the strait with one
      // gently crowned road is what makes the merge read as continuous land.
      if (reg.neck) {
        const ax = reg.neck.ax;
        const az = reg.neck.az;
        const vx = reg.x - ax;
        const vz = reg.z - az;
        const len = Math.hypot(vx, vz) || 1;
        const ux = vx / len;
        const uz = vz / len;
        const px = x - ax;
        const pz = z - az;
        const along = px * ux + pz * uz;
        // extend a little behind the anchor so its foot buries itself in the
        // beach instead of ending in a free-standing lip
        const overshoot = reg.neck.width * 0.55;
        if (along > -overshoot && along < len + overshoot) {
          const perp = Math.abs(px * uz - pz * ux);
          const halfW = reg.neck.width * 0.5;
          if (perp < halfW) {
            const u = Math.max(0, Math.min(1, along / len));
            // cross profile: flat crown in the middle, long soft shoulders
            const across = 1 - smoothstep(halfW * 0.5, halfW, perp);
            // FULL height from the anchor outward. Ramping up out of the water
            // half-way across left a dip right where the two shores meet, which
            // is exactly the "一个一个水沟" seam this bridge exists to remove.
            const endLift = smoothstep(-overshoot, 0, along);
            // along profile: meets the beach at the anchor height, climbs to the
            // dome's shoulder, and crowns gently in between
            const shoulder = lerp(reg.neck.height, reg.height * 0.55, u);
            const crown = 0.92 + Math.sin(u * Math.PI) * 0.26;
            const neckH = shoulder * crown * endLift;
            const w = across;
            if (w > 0.001) out = smoothMax(out, lerp(-1.2, neckH, w), 2.8);
          }
        }
      }
    }

    return out;
  }

  /** Approximate slope 0..1 from finite differences — used for shading & placement. */
  slope(x: number, z: number): number {
    const d = 0.9;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    return Math.min(1, Math.hypot(hx, hz) / (2 * d) * 0.9);
  }

  normal(x: number, z: number): [number, number, number] {
    const d = 0.7;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    const nx = -hx;
    const nz = -hz;
    const ny = 2 * d;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  /** True when a position is walkable land above the tide line. */
  isLand(x: number, z: number, minH = 0.35): boolean {
    return this.height(x, z) >= minH;
  }

  regionName(x: number, z: number): string {
    const n = this.base.noise(x * 0.017 + 2.3, z * 0.017 - 1.1);
    const h = this.height(x, z);
    if (h < 0.5) return '潮汐浅滩';
    if (h > 11) return '云脊高地';
    if (n > 0.22) return '晨雾浅滩';
    if (n < -0.3) return '苔影缓坡';
    return '风息林缘';
  }
}

/** Deterministic scatter points that respect slope/height so nothing floats or buries. */
export interface ScatterPoint {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  variant: number;
}

export function scatter(
  field: IslandField,
  count: number,
  seed: number,
  opts: {
    minH?: number;
    maxH?: number;
    maxSlope?: number;
    radius?: number;
    /** sample around this centre instead of the world origin */
    centre?: { x: number; z: number };
    minSpacing?: number;
    scaleMin?: number;
    scaleMax?: number;
    variants?: number;
    biomeBias?: (x: number, z: number, h: number) => number;
  },
): ScatterPoint[] {
  const rnd = mulberry32(seed);
  const out: ScatterPoint[] = [];
  const minH = opts.minH ?? 0.7;
  const maxH = opts.maxH ?? 24;
  const maxSlope = opts.maxSlope ?? 0.55;
  const radius = opts.radius ?? 47;
  const minSpacing = opts.minSpacing ?? 2.2;
  const variants = opts.variants ?? 3;
  const maxTries = count * 34;
  const centre = opts.centre ?? { x: 0, z: 0 };
  let tries = 0;
  while (out.length < count && tries < maxTries) {
    tries++;
    const x = centre.x + (rnd() * 2 - 1) * radius;
    const z = centre.z + (rnd() * 2 - 1) * radius;
    const h = field.height(x, z);
    if (h < minH || h > maxH) continue;
    if (field.slope(x, z) > maxSlope) continue;
    if (opts.biomeBias && rnd() > opts.biomeBias(x, z, h)) continue;
    let tooClose = false;
    for (const p of out) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < minSpacing * minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    out.push({
      x,
      z,
      y: h,
      scale: lerp(opts.scaleMin ?? 0.85, opts.scaleMax ?? 1.2, rnd()),
      rot: rnd() * Math.PI * 2,
      variant: Math.floor(rnd() * variants),
    });
  }
  return out;
}

export const biomeWeights = (h: number) => ({
  lowland: clamp01(smoothstep(6.8, 3.2, h)),
  slope: clamp01(smoothstep(2.4, 5.2, h) * smoothstep(11, 7.8, h)),
  high: clamp01(smoothstep(7.4, 11.2, h)),
});
