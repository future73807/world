/**
 * Biomes of the Mist Isles.
 *
 * A biome is a climate, not a patch of ground. Each one is a region of temperature
 * and moisture (the volcano adds volcanic activity), and the world's climate is one
 * continuous field — so forest fades into grassland and grassland into desert over
 * tens of BU, and nothing is laid out tile by tile. What a biome fixes is how the
 * ground is shaped and coloured, and which Blender prefabs are at home there.
 *
 * Which prefabs actually grow where is decided by each species' niche (SPECIES
 * below): a density that follows the climate, so a tree line or a shore is a
 * gradient of mixed species rather than a border.
 */
import type { BiomeId } from './world';

export type TileFeature = 'none' | 'volcano' | 'peak' | 'crater' | 'pond';

export interface PropRule {
  /** prefab id (see app/public/models/prefabs.json) */
  model: string;
  /** target number of instances per 40 BU tile when the niche is fully satisfied */
  n: number;
  minH?: number;
  maxH?: number;
  maxSlope?: number;
  /** minimum distance between two instances of this rule */
  spacing?: number;
  /** sits on the water surface (lily pads, coral in the shallows) */
  water?: boolean;
  /** at most one per tile, placed on the flattest spot that qualifies */
  landmark?: boolean;
  /** 0..1 — only grow where a low-frequency patch noise exceeds this (drifts of grass) */
  cluster?: number;
  scale?: [number, number];
}

/**
 * How much of each climate a place has. They partition the land (snow + desert +
 * swamp + forest + meadow = 1 before the volcano takes its share); `taiga` says
 * how cold-adapted the vegetation is inside the cold part.
 */
export interface BiomeWeights {
  snow: number;
  desert: number;
  swamp: number;
  forest: number;
  meadow: number;
  volcanic: number;
  taiga: number;
  /** hottest + wettest: a rainforest band above `forest` */
  jungle: number;
  /** hot, very dry, terraced: the banded clay country */
  badlands: number;
  /** cold but above the tree line: moss and lichen, no tall trees */
  tundra: number;
  /** high ground: grass thinning into rock, wherever it happens to be */
  highland: number;
}

/** A species and the climate it grows in: `niche` is a density factor from the climate (1 = as dense as `n`). */
export interface SpeciesRule extends PropRule {
  niche: (w: BiomeWeights, temp: number, moist: number) => number;
}

export interface BiomeDef {
  id: BiomeId;
  /** region name shown in the HUD */
  label: string;
  /** centre of the biome's climate: temperature 0 (cold) → 1 (hot), moisture 0 (dry) → 1 (wet) */
  temp: number;
  moist: number;
  /** what the ground is like here: share of land, relief height, roughness */
  land: number;
  peak: number;
  rough: number;
  feature: TileFeature;
  /** ground up to this height is shore-coloured */
  beachH: number;
  /** ground above this is snow-capped; 99 = never */
  snowline: number;
  /** sRGB hex ground palette */
  ground: { shore: number; wet: number; low: number; mid: number; high: number; rock: number; deep: number };
  /** map palette (sRGB hex) */
  map: { low: number; high: number; shore: string };
  /** the species at home here, in the numbers an AI region card may ask for */
  props: PropRule[];
  /** one line for the AI and the region summary */
  blurb: string;
}

const R = (model: string, n: number, extra: Partial<PropRule> = {}): PropRule => ({ model, n, ...extra });

/** smoothstep that also accepts a falling edge (from > to) */
const ss = (from: number, to: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - from) / (to - from || 1e-9)));
  return t * t * (3 - 2 * t);
};

export const BIOME_ORDER: BiomeId[] = [
  'meadow', 'forest', 'jungle', 'highland', 'snow', 'tundra', 'desert', 'badlands', 'swamp', 'volcanic', 'beach', 'ocean',
];

export const BIOMES: Record<BiomeId, BiomeDef> = {
  meadow: {
    id: 'meadow', label: '风息草甸', temp: 0.6, moist: 0.4, land: 0.7, peak: 6, rough: 0.3,
    feature: 'none', beachH: 1.3, snowline: 99,
    ground: { shore: 0xe9dcb2, wet: 0xcdb98a, low: 0x9ccb6e, mid: 0x7fbf5c, high: 0xb2d984, rock: 0x94a0a2, deep: 0x6f7a70 },
    map: { low: 0xa8ce93, high: 0xe0edc4, shore: '#f3ecdc' },
    blurb: '缓坡草地，零星的平顶伞树和成片野花，适合放风筝的开阔地。',
    props: [
      R('cc0_maple_a', 6, { minH: 1.5, maxSlope: 0.3, spacing: 8 }),
      R('cc0_bush_a', 9, { minH: 1.3, spacing: 2.4 }),
      R('cc0_bush_b', 6, { minH: 1.3, spacing: 2.4 }),
      R('cc0_grass_a', 260, { minH: 1.2, maxSlope: 0.7, spacing: 0.9 }),
      R('cc0_grass_b', 90, { minH: 1.4, maxSlope: 0.6, spacing: 1.1 }),
      R('cc0_flower_a', 55, { minH: 1.3, maxSlope: 0.4, spacing: 1.4 }),
      R('cc0_flower_b', 40, { minH: 1.3, maxSlope: 0.4, spacing: 1.4 }),
      R('cc0_flower_a', 40, { minH: 1.3, maxSlope: 0.4, spacing: 1.4 }),
      R('cc0_boulder_a', 7, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),
      R('cc0_boulder_a', 12, { minH: 0.8, maxSlope: 0.9, spacing: 1.5 }),
      R('cc0_rock_arch', 1, { minH: 1.8, maxSlope: 0.22, spacing: 9, landmark: true }),
      R('cc0_deer', 2, { minH: 1.2, maxSlope: 0.3, spacing: 6 }),
      R('cc0_cow', 1, { minH: 1.2, maxSlope: 0.28, spacing: 6 }),
      R('cc0_chicken', 3, { minH: 1.1, maxSlope: 0.35, spacing: 4 }),
      R('cc0_hedgehog', 2, { minH: 1.1, maxSlope: 0.35, spacing: 4 }),
      R('cc0_cart', 1, { minH: 1.3, maxSlope: 0.25, spacing: 6 }),
      R('cc0_hay', 2, { minH: 1.3, maxSlope: 0.3, spacing: 4 }),
    ],
  },
  forest: {
    id: 'forest', label: '苍郁林地', temp: 0.55, moist: 0.7, land: 0.8, peak: 9, rough: 0.42,
    feature: 'none', beachH: 1.2, snowline: 99,
    ground: { shore: 0xe6d8ae, wet: 0xc9b487, low: 0x8cc65f, mid: 0x63aa52, high: 0x93c86e, rock: 0x8a9490, deep: 0x66736a },
    map: { low: 0x9cc68a, high: 0xd6e6b8, shore: '#f3ecdc' },
    blurb: '起伏的密林，折伞树、高冠树和开粉花的绯花树混生，林下有蘑菇和倒木。',
    props: [
      R('cc0_broadleaf_a', 15, { minH: 1.4, maxSlope: 0.42, spacing: 3.6 }),
      R('cc0_broadleaf_b', 10, { minH: 1.6, maxSlope: 0.4, spacing: 3.6 }),
      R('cc0_broadleaf_c', 4, { minH: 1.5, maxSlope: 0.35, spacing: 4.2 }),
      R('cc0_bush_c', 8, { minH: 1.3, spacing: 2.2 }),
      R('cc0_grass_c', 260, { minH: 1.2, maxSlope: 0.7, spacing: 0.9 }),
      R('cc0_grass_a', 90, { minH: 1.3, maxSlope: 0.6, spacing: 1.0 }),
      R('cc0_mushroom_s', 45, { minH: 1.2, maxSlope: 0.5, spacing: 1.2 }),
      R('cc0_stump', 3, { minH: 1.3, maxSlope: 0.4, spacing: 4 }),
      R('cc0_log', 4, { minH: 1.2, maxSlope: 0.35, spacing: 4 }),
      R('cc0_boulder_c', 7, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),
      R('cc0_boulder_b', 4, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),
      R('cc0_boulder_a', 12, { minH: 0.8, maxSlope: 0.9, spacing: 1.5 }),
      R('cc0_ancient', 1, { minH: 2.2, maxSlope: 0.25, spacing: 10, landmark: true }),
      R('cc0_deer', 2, { minH: 1.3, maxSlope: 0.35, spacing: 6 }),
      R('cc0_hedgehog', 3, { minH: 1.1, maxSlope: 0.4, spacing: 4 }),
    ],
  },
  snow: {
    id: 'snow', label: '霜脊雪原', temp: 0.12, moist: 0.5, land: 0.72, peak: 14, rough: 0.55,
    feature: 'none', beachH: 1.1, snowline: 0,
    ground: { shore: 0xd7e3ea, wet: 0xb9cbd6, low: 0xf1f6fb, mid: 0xeaf1f8, high: 0xffffff, rock: 0x8794a3, deep: 0x7d8a94 },
    map: { low: 0xeaf2f8, high: 0xffffff, shore: '#e4edf3' },
    blurb: '刀脊一样的雪峰，成片的霜杉顶着厚雪，冰晶簇从冻土里斜插出来。',
    props: [
      R('cc0_pine_a', 16, { minH: 1.4, maxSlope: 0.5, spacing: 3.6 }),
      R('cc0_pine_b', 12, { minH: 1.2, maxSlope: 0.5, spacing: 3.2 }),
      R('cc0_pine_snow', 6, { minH: 1.6, maxSlope: 0.45, spacing: 4 }),
      R('cc0_dead_snow', 5, { minH: 1.3, maxSlope: 0.45, spacing: 4 }),
      R('cc0_snowrock_a', 12, { minH: 0.9, maxSlope: 0.95, spacing: 3 }),
      R('cc0_boulder_d', 5, { minH: 0.9, maxSlope: 0.95, spacing: 3 }),
      R('cc0_crystal_a', 6, { minH: 1.2, maxSlope: 0.6, spacing: 4 }),
      R('cc0_boulder_a', 6, { minH: 0.8, maxSlope: 0.9, spacing: 1.6 }),
      R('cc0_crystal_e', 1, { minH: 2.0, maxSlope: 0.25, spacing: 9, landmark: true }),
      R('cc0_fox', 2, { minH: 1.2, maxSlope: 0.4, spacing: 6 }),
    ],
  },
  desert: {
    id: 'desert', label: '鸣沙荒漠', temp: 0.92, moist: 0.12, land: 0.68, peak: 7, rough: 0.3,
    feature: 'none', beachH: 1.6, snowline: 99,
    ground: { shore: 0xf0dfb0, wet: 0xd9c18c, low: 0xecd39a, mid: 0xe2c486, high: 0xf2ddad, rock: 0xc98a5c, deep: 0xb39a70 },
    map: { low: 0xe8d19c, high: 0xf6e8c2, shore: '#f3ecdc' },
    blurb: '一层层风成沙丘和赭红台地，柱状仙人掌顶着花，风蚀方尖碑半埋在沙里。',
    props: [
      R('desert_cactus_a', 7, { minH: 1.4, maxSlope: 0.45, spacing: 5 }),
      R('desert_cactus_b', 9, { minH: 1.3, maxSlope: 0.45, spacing: 4 }),
      R('cc0_bush_d', 13, { minH: 1.2, maxSlope: 0.5, spacing: 3 }),
      R('cc0_grass_c', 200, { minH: 1.1, maxSlope: 0.6, spacing: 1.0 }),
      R('desert_mesa', 3, { minH: 1.4, maxSlope: 0.5, spacing: 8 }),
      R('cc0_painted_rock', 10, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),
      R('cc0_standing_b', 4, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),
      R('cc0_boulder_a', 12, { minH: 0.8, maxSlope: 0.9, spacing: 1.5 }),
      R('landmark_obelisk', 1, { minH: 1.8, maxSlope: 0.25, spacing: 9, landmark: true }),
    ],
  },
  swamp: {
    id: 'swamp', label: '沉雾泽地', temp: 0.65, moist: 0.95, land: 0.74, peak: 2.4, rough: 0.3,
    feature: 'none', beachH: 0.9, snowline: 99,
    ground: { shore: 0x6f6746, wet: 0x574f36, low: 0x6d7f45, mid: 0x5c7440, high: 0x7f9452, rock: 0x5d6a5e, deep: 0x4c5340 },
    map: { low: 0x93a568, high: 0xb1bd86, shore: '#cfc49a' },
    blurb: '比水面高不了多少的洼地，到处是水洼和芦苇，垂枝沼柳和发光的灯菌长在泥里。',
    props: [
      R('cc0_willow_a', 12, { minH: 0.7, maxSlope: 0.35, spacing: 4.6 }),
      R('swamp_mushroom_a', 7, { minH: 0.6, maxSlope: 0.4, spacing: 4 }),
      R('swamp_mushroom_b', 24, { minH: 0.5, maxSlope: 0.5, spacing: 2.2 }),
      R('cc0_reed_a', 150, { minH: -0.1, maxH: 1.2, maxSlope: 0.5, spacing: 0.8 }),
      R('cc0_lilypad_a', 40, { minH: -1.4, maxH: -0.12, spacing: 1.0, water: true }),
      R('cc0_dead_c', 6, { minH: 0.5, maxSlope: 0.4, spacing: 4 }),
      R('cc0_mossrock_a', 9, { minH: 0.2, maxSlope: 0.9, spacing: 3 }),
      R('cc0_log', 4, { minH: 0.5, maxSlope: 0.35, spacing: 4 }),
      R('cc0_grass_b', 90, { minH: 0.4, maxSlope: 0.6, spacing: 1.1 }),
      R('cc0_giant_mushroom_a', 1, { minH: 0.6, maxSlope: 0.22, spacing: 10, landmark: true }),
      R('cc0_frog', 6, { minH: 0.3, maxSlope: 0.5, spacing: 4.5 }),
    ],
  },
  volcanic: {
    id: 'volcanic', label: '余烬火山', temp: 0.9, moist: 0.25, land: 0.74, peak: 9, rough: 0.65,
    feature: 'volcano', beachH: 1.2, snowline: 99,
    ground: { shore: 0x3f3b3b, wet: 0x2c2929, low: 0x565350, mid: 0x48464a, high: 0x6d6a6a, rock: 0x3a3d44, deep: 0x2f3438 },
    map: { low: 0x77747a, high: 0xa39fa4, shore: '#bdb8b2' },
    blurb: '黑沙海岸背后的熄火山，玄武岩柱和黑曜石尖晶之间立着焦木，喷口还透着熔光。',
    props: [
      R('cc0_crystal_c', 9, { minH: 1.0, maxSlope: 0.7, spacing: 4 }),
      R('cc0_standing_a', 7, { minH: 1.0, maxSlope: 0.7, spacing: 5 }),
      R('cc0_dead_a', 10, { minH: 1.0, maxSlope: 0.5, spacing: 4.5 }),
      R('cc0_standing_b', 16, { minH: 0.9, maxSlope: 0.95, spacing: 3 }),
      R('cc0_boulder_b', 6, { minH: 0.9, maxSlope: 0.95, spacing: 3 }),
      R('cc0_boulder_a', 14, { minH: 0.7, maxSlope: 0.9, spacing: 1.6 }),
      R('landmark_vent', 1, { minH: 1.6, maxSlope: 0.3, spacing: 10, landmark: true }),
    ],
  },
  beach: {
    id: 'beach', label: '潮白沙岸', temp: 0.8, moist: 0.4, land: 0.6, peak: 3.2, rough: 0.22,
    feature: 'none', beachH: 2.6, snowline: 99,
    ground: { shore: 0xf2e6bf, wet: 0xdccb9c, low: 0xf0e0b4, mid: 0xe9d8a6, high: 0xc9d994, rock: 0xb9b4a6, deep: 0xa9a486 },
    map: { low: 0xf1e6c6, high: 0xd6e4ae, shore: '#f3ecdc' },
    blurb: '浅色的沙滩，弯椰树成排，浮木和海星散在水线上，远处立着鲸骨拱。',
    props: [
      R('palm_a', 8, { minH: 1.0, maxH: 4.5, maxSlope: 0.3, spacing: 5.5 }),
      R('palm_b', 6, { minH: 1.0, maxH: 4.5, maxSlope: 0.3, spacing: 5 }),
      R('cc0_log_long', 5, { minH: 0.4, maxH: 2.4, maxSlope: 0.4, spacing: 4 }),
      R('cc0_boulder_e', 3, { minH: 0.8, maxSlope: 0.9, spacing: 4 }),
      R('beach_starfish', 30, { minH: 0.25, maxH: 1.6, maxSlope: 0.3, spacing: 1.6 }),
      R('landmark_ribs', 1, { minH: 0.8, maxSlope: 0.22, spacing: 9, landmark: true }),
      R('cc0_cat', 1, { minH: 1.0, maxSlope: 0.3, spacing: 6 }),
      R('cc0_chicken', 2, { minH: 1.0, maxSlope: 0.3, spacing: 4 }),
      R('cc0_campfire', 1, { minH: 1.2, maxSlope: 0.22, spacing: 6 }),
      R('cc0_barrel_a', 1, { minH: 1.1, maxSlope: 0.3, spacing: 4 }),
      R('cc0_crate_a', 2, { minH: 1.1, maxSlope: 0.3, spacing: 4 }),
      R('cc0_boat', 1, { minH: 0.9, maxSlope: 0.25, spacing: 6 }),
    ],
  },
  jungle: {
    id: 'jungle', label: '藤蔓雨林', temp: 0.9, moist: 0.92, land: 0.82, peak: 10, rough: 0.5,
    feature: 'none', beachH: 1.4, snowline: 99,
    ground: { shore: 0xd8cc96, wet: 0xb9c47a, low: 0x4e8f3a, mid: 0x3d7a30, high: 0x5fa244, rock: 0x6f7a66, deep: 0x46603f },
    map: { low: 0x5c9548, high: 0x9ac276, shore: '#e6dcb4' },
    blurb: '湿热得能拧出水的密林，藤蔓从高冠垂到地面，林下是层层蕨与巨叶。',
    props: [
      R('cc0_broadleaf_c', 14, { minH: 1.4, maxSlope: 0.45, spacing: 3.2 }),
      R('cc0_broadleaf_a', 12, { minH: 1.4, maxSlope: 0.42, spacing: 3.4 }),
      R('cc0_bamboo_a', 10, { minH: 1.3, maxSlope: 0.4, spacing: 2.6 }),
      R('cc0_vine', 22, { minH: 1.2, maxSlope: 0.5, spacing: 2.0 }),
      R('cc0_fern_a', 40, { minH: 1.1, maxSlope: 0.5, spacing: 1.4 }),
      R('cc0_fern_b', 28, { minH: 1.0, maxSlope: 0.5, spacing: 1.5 }),
      R('cc0_bush_c', 10, { minH: 1.2, maxSlope: 0.4, spacing: 2.4 }),
      R('cc0_grass_c', 220, { minH: 1.2, maxSlope: 0.7, spacing: 0.9 }),
      R('cc0_mushroom_m', 30, { minH: 1.1, maxSlope: 0.5, spacing: 1.6 }),
      R('cc0_deer', 2, { minH: 1.2, maxSlope: 0.35, spacing: 5 }),
      R('cc0_frog', 6, { minH: 0.6, maxSlope: 0.5, spacing: 3 }),
      R('cc0_giant_mushroom_b', 1, { minH: 1.2, maxSlope: 0.24, spacing: 10, landmark: true }),
    ],
  },
  badlands: {
    id: 'badlands', label: '赤色恶地', temp: 0.92, moist: 0.12, land: 0.68, peak: 8, rough: 0.62,
    feature: 'none', beachH: 1.5, snowline: 99,
    ground: { shore: 0xd9a878, wet: 0xc08a5c, low: 0xb5673c, mid: 0xa2562f, high: 0xc78a52, rock: 0x8c5230, deep: 0x6e3f24 },
    map: { low: 0xb96a3e, high: 0xdcaa72, shore: '#e4c49a' },
    blurb: '风把软泥岩一层层刮出条纹，赤橙的台地之间只剩干裂的河床和零星的枯灌。',
    props: [
      R('cc0_painted_rock', 14, { minH: 0.9, maxSlope: 0.9, spacing: 2.6 }),
      R('cc0_standing_c', 8, { minH: 1.0, maxSlope: 0.7, spacing: 4 }),
      R('cc0_boulder_c', 10, { minH: 0.8, maxSlope: 0.9, spacing: 2.4 }),
      R('cc0_dead_b', 6, { minH: 0.9, maxSlope: 0.5, spacing: 5 }),
      R('cc0_bush_d', 12, { minH: 0.9, maxSlope: 0.5, spacing: 2.6 }),
      R('cc0_grass_c', 90, { minH: 1.0, maxSlope: 0.6, spacing: 1.4 }),
      R('cc0_hedgehog', 2, { minH: 0.9, maxSlope: 0.4, spacing: 5 }),
      R('desert_mesa', 3, { minH: 1.2, maxSlope: 0.5, spacing: 7 }),
      R('landmark_obelisk', 1, { minH: 1.6, maxSlope: 0.28, spacing: 10, landmark: true }),
    ],
  },
  tundra: {
    id: 'tundra', label: '苔原冻土', temp: 0.26, moist: 0.44, land: 0.76, peak: 7, rough: 0.4,
    feature: 'none', beachH: 1.2, snowline: 3,
    ground: { shore: 0xcfd6d2, wet: 0xb4bdb8, low: 0x8f9c86, mid: 0x7d8c78, high: 0xb9c2b0, rock: 0x77807c, deep: 0x5f6a64 },
    map: { low: 0x93a08c, high: 0xcdd4c6, shore: '#dfe4dd' },
    blurb: '雪线以下的冻土，地衣和矮柳贴着地面长，风把石头磨得圆钝。',
    props: [
      R('cc0_bush_snow', 16, { minH: 1.0, maxSlope: 0.5, spacing: 2.4 }),
      R('cc0_bush_e', 12, { minH: 1.0, maxSlope: 0.5, spacing: 2.6 }),
      R('cc0_dead_snow', 4, { minH: 1.0, maxSlope: 0.45, spacing: 5 }),
      R('cc0_grass_b', 160, { minH: 0.9, maxSlope: 0.6, spacing: 1.0 }),
      R('cc0_snowrock_b', 12, { minH: 0.8, maxSlope: 0.9, spacing: 2.6 }),
      R('cc0_boulder_b', 8, { minH: 0.8, maxSlope: 0.9, spacing: 3 }),
      R('cc0_fox', 2, { minH: 1.0, maxSlope: 0.4, spacing: 6 }),
      R('cc0_hedgehog', 2, { minH: 0.9, maxSlope: 0.4, spacing: 5 }),
      R('cc0_standing_a', 1, { minH: 1.4, maxSlope: 0.28, spacing: 11, landmark: true }),
    ],
  },
  highland: {
    id: 'highland', label: '裂风高地', temp: 0.42, moist: 0.5, land: 0.7, peak: 13, rough: 0.58,
    feature: 'none', beachH: 1.2, snowline: 11,
    ground: { shore: 0xc8c2a8, wet: 0xb0a992, low: 0x8f9a72, mid: 0x7d8a66, high: 0xa5ad8c, rock: 0x8a8a86, deep: 0x6b6d68 },
    map: { low: 0x97a17e, high: 0xd0d2bc, shore: '#ded9c4' },
    blurb: '抬升的台地边缘，草皮被风刮薄，露出成片的碎石与裸岩。',
    props: [
      R('cc0_broadleaf_d', 5, { minH: 1.6, maxSlope: 0.34, spacing: 5 }),
      R('cc0_bush_a', 10, { minH: 1.2, maxSlope: 0.45, spacing: 2.4 }),
      R('cc0_grass_a', 200, { minH: 1.2, maxSlope: 0.7, spacing: 0.95 }),
      R('cc0_grass_b', 80, { minH: 1.2, maxSlope: 0.65, spacing: 1.1 }),
      R('cc0_boulder_e', 12, { minH: 0.9, maxSlope: 0.9, spacing: 2.6 }),
      R('cc0_cliff_a', 6, { minH: 1.0, maxSlope: 0.95, spacing: 4 }),
      R('cc0_flower_a', 40, { minH: 1.2, maxSlope: 0.4, spacing: 1.5 }),
      R('cc0_deer', 2, { minH: 1.3, maxSlope: 0.4, spacing: 6 }),
      R('cc0_rock_arch', 1, { minH: 1.8, maxSlope: 0.24, spacing: 10, landmark: true }),
    ],
  },
  ocean: {
    id: 'ocean', label: '碧礁浅海', temp: 0.75, moist: 0.6, land: 0.24, peak: 2.4, rough: 0.25,
    feature: 'none', beachH: 2.2, snowline: 99,
    ground: { shore: 0xf4e8c6, wet: 0xe2d2a4, low: 0xf0e1b6, mid: 0xdfe6b8, high: 0xcfe0a8, rock: 0xc4bfae, deep: 0xb2ad90 },
    map: { low: 0xf0e5c4, high: 0xd8e5b4, shore: '#f3ecdc' },
    blurb: '几乎全是水的浅潟湖，只剩几道沙洲和小岛，五彩的珊瑚长在清澈的浅水里。',
    props: [
      R('palm_a', 3, { minH: 1.0, maxH: 4.0, maxSlope: 0.3, spacing: 6 }),
      R('coral_branch', 36, { minH: -1.2, maxH: 0.7, maxSlope: 0.6, spacing: 1.3 }),
      R('coral_brain', 18, { minH: -1.2, maxH: 0.7, maxSlope: 0.6, spacing: 1.6 }),
      R('coral_fan', 18, { minH: -1.0, maxH: 0.7, maxSlope: 0.6, spacing: 1.6 }),
      R('beach_starfish', 20, { minH: 0.25, maxH: 1.4, maxSlope: 0.3, spacing: 1.8 }),
      R('cc0_log_long', 3, { minH: 0.4, maxH: 2.0, maxSlope: 0.4, spacing: 5 }),
      R('landmark_ribs', 1, { minH: 0.8, maxSlope: 0.22, spacing: 9, landmark: true }),
    ],
  },
};

/**
 * Which biomes may border which. With a continuous climate most neighbours agree by
 * themselves; the table is what an AI region card is held to when it steers a tile
 * towards a biome of its own.
 */
export const BIOME_NEIGHBOURS: Record<BiomeId, BiomeId[]> = {
  meadow: ['meadow', 'forest', 'beach', 'desert', 'snow', 'swamp', 'highland', 'tundra'],
  forest: ['forest', 'meadow', 'swamp', 'snow', 'desert', 'jungle', 'highland'],
  snow: ['snow', 'forest', 'meadow', 'volcanic', 'tundra', 'highland'],
  desert: ['desert', 'volcanic', 'beach', 'meadow', 'forest', 'badlands'],
  swamp: ['swamp', 'forest', 'meadow', 'ocean', 'jungle'],
  volcanic: ['volcanic', 'desert', 'snow', 'beach', 'badlands'],
  beach: ['beach', 'ocean', 'desert', 'meadow', 'forest', 'jungle'],
  ocean: ['ocean', 'beach', 'swamp', 'meadow'],
  // the added terrains neighbour the places they were split from, plus each other where
  // the climate between them is continuous
  jungle: ['jungle', 'forest', 'swamp', 'beach', 'meadow'],
  badlands: ['badlands', 'desert', 'volcanic', 'highland', 'meadow'],
  tundra: ['tundra', 'snow', 'meadow', 'highland', 'forest'],
  highland: ['highland', 'meadow', 'forest', 'snow', 'tundra', 'badlands', 'desert'],
};

// --------------------------------------------------------------------------- species

const S = (model: string, n: number, niche: SpeciesRule['niche'], extra: Partial<PropRule> = {}): SpeciesRule => ({ model, n, niche, ...extra });

/** Palms and coral want warmth; cold shores stay bare. */
const warm = (temp: number) => ss(0.4, 0.62, temp);
/** Grass and broadleaf trees thin out as it freezes. */
const frost = (w: BiomeWeights) => 1 - w.snow;
/** Ferns and flowers shun aridity. */
const arid = (w: BiomeWeights) => 1 - w.desert;

/**
 * Every species that spreads by climate, with the density it reaches where its niche
 * is fully satisfied. A tile opened by the AI may list its own props instead; the
 * birth island and tiles without a card use this table.
 */
export const SPECIES: SpeciesRule[] = [
  // — temperate broadleaf forest
  S('cc0_broadleaf_a', 15, (w) => w.forest * 0.9 + w.swamp * 0.1, { minH: 1.4, maxSlope: 0.42, spacing: 3.6 }),
  S('cc0_broadleaf_b', 10, (w) => w.forest * 0.9 + w.swamp * 0.08, { minH: 1.6, maxSlope: 0.4, spacing: 3.6 }),
  S('cc0_broadleaf_c', 4, (w) => w.forest * 0.8 + w.meadow * 0.06, { minH: 1.5, maxSlope: 0.35, spacing: 4.2 }),
  S('cc0_stump', 3, (w) => w.forest, { minH: 1.3, maxSlope: 0.4, spacing: 4 }),
  S('cc0_log', 4, (w) => w.forest + w.swamp * 0.5, { minH: 0.6, maxSlope: 0.35, spacing: 4 }),
  S('cc0_mushroom_m', 45, (w) => w.forest * 0.9 + w.swamp * 0.6, { minH: 0.5, maxSlope: 0.5, spacing: 1.2 }),

  // — grassland: scattered umbrella trees, bushes, drifts of grass and flowers
  S('cc0_maple_a', 6, (w) => w.meadow * 0.9 + w.forest * 0.08, { minH: 1.5, maxSlope: 0.3, spacing: 8 }),
  S('cc0_bush_berries', 6, (w) => w.meadow, { minH: 1.3, spacing: 2.4 }),
  S('cc0_bush_b', 8, (w) => w.meadow * 0.8 + w.forest * 0.35 + w.swamp * 0.2, { minH: 1.3, spacing: 2.2 }),
  S('cc0_grass_a', 300, (w) => (w.meadow + w.forest * 0.85 + w.swamp * 0.5) * frost(w) * 0.95 + 0.04, { minH: 0.8, maxSlope: 0.7, spacing: 0.9, cluster: -0.25 }),
  S('cc0_grass_a', 110, (w) => (w.meadow * 0.9 + w.forest * 0.45 + w.swamp * 0.5) * frost(w) * 0.95, { minH: 0.6, maxSlope: 0.6, spacing: 1.0 }),
  S('cc0_flower_b', 55, (w) => (w.meadow * 0.9 + w.forest * 0.3) * arid(w) * frost(w), { minH: 1.1, maxSlope: 0.4, spacing: 1.4 }),
  S('cc0_flower_a', 45, (w) => (w.meadow * 0.8 + w.forest * 0.3) * arid(w) * frost(w), { minH: 1.1, maxSlope: 0.4, spacing: 1.4 }),
  S('cc0_flower_b', 45, (w) => (w.meadow * 0.75 + w.forest * 0.25) * arid(w) * frost(w), { minH: 1.1, maxSlope: 0.4, spacing: 1.4 }),

  // — stones turn up everywhere; slabs like dry ground
  S('cc0_mossrock_a', 7, () => 0.8, { minH: 0.8, maxSlope: 0.95, spacing: 3 }),
  S('cc0_boulder_d', 4, (w) => 0.6 + w.snow * 0.8 + w.volcanic * 0.6, { minH: 0.6, maxSlope: 0.95, spacing: 3 }),
  S('cc0_boulder_a', 12, () => 0.9, { minH: 0.5, maxSlope: 0.95, spacing: 1.5 }),
  S('cc0_painted_rock', 3, (w) => 0.15 + w.desert * 0.85, { minH: 0.8, maxSlope: 0.9, spacing: 4 }),

  // — the cold: pines take over from broadleaf trees, then only snow and ice remain
  S('cc0_pine_a', 16, (w) => w.taiga, { minH: 1.4, maxSlope: 0.5, spacing: 3.6 }),
  S('cc0_pine_b', 12, (w) => w.taiga * 0.9, { minH: 1.2, maxSlope: 0.5, spacing: 3.2 }),
  S('cc0_pine_snow', 6, (w) => w.taiga * 0.7, { minH: 1.6, maxSlope: 0.45, spacing: 4 }),
  S('cc0_dead_snow', 5, (_w, temp) => ss(0.32, 0.16, temp), { minH: 1.3, maxSlope: 0.45, spacing: 4 }),
  S('cc0_snowrock_b', 12, (w) => w.snow, { minH: 0.9, maxSlope: 0.95, spacing: 3 }),
  S('cc0_crystal_b', 6, (w) => w.snow * (1 - w.taiga * 0.4), { minH: 1.2, maxSlope: 0.6, spacing: 4 }),

  // — the dry side: cactus, thorn scrub, mesas
  S('desert_cactus_a', 7, (w) => w.desert, { minH: 1.4, maxSlope: 0.45, spacing: 5 }),
  S('desert_cactus_b', 9, (w) => w.desert, { minH: 1.3, maxSlope: 0.45, spacing: 4 }),
  S('cc0_bush_d', 13, (w, _t, moist) => w.desert * 0.85 + w.meadow * ss(0.42, 0.2, moist) * 0.6, { minH: 1.2, maxSlope: 0.5, spacing: 3 }),
  S('cc0_grass_c', 200, (w) => w.desert * 0.9, { minH: 1.0, maxSlope: 0.6, spacing: 1.0 }),
  S('desert_mesa', 3, (w) => w.desert, { minH: 1.4, maxSlope: 0.5, spacing: 8 }),
  S('cc0_standing_c', 10, (w) => w.desert, { minH: 1.0, maxSlope: 0.9, spacing: 3 }),

  // — warm wet lowland: willows, glowing mushrooms, reeds and lilies
  S('cc0_willow_a', 12, (w) => w.swamp, { minH: 0.7, maxSlope: 0.35, spacing: 4.6 }),
  S('swamp_mushroom_a', 7, (w) => w.swamp, { minH: 0.6, maxSlope: 0.4, spacing: 4 }),
  S('swamp_mushroom_b', 24, (w) => w.swamp, { minH: 0.5, maxSlope: 0.5, spacing: 2.2 }),
  S('cc0_reed_b', 150, (w) => w.swamp + w.forest * 0.06 + w.meadow * 0.03, { minH: -0.1, maxH: 1.2, maxSlope: 0.5, spacing: 0.8 }),
  S('cc0_lilypad_b', 40, (w) => w.swamp, { minH: -1.4, maxH: -0.12, spacing: 1.0, water: true }),
  S('cc0_dead_c', 6, (w) => w.swamp, { minH: 0.5, maxSlope: 0.4, spacing: 4 }),
  S('cc0_mossrock_b', 9, (w) => w.swamp, { minH: 0.2, maxSlope: 0.9, spacing: 3 }),

  // — volcanic ground
  S('cc0_crystal_b', 9, (w) => w.volcanic, { minH: 1.0, maxSlope: 0.7, spacing: 4 }),
  S('cc0_cliff_b', 7, (w) => w.volcanic, { minH: 1.0, maxSlope: 0.7, spacing: 5 }),
  S('cc0_dead_a', 10, (w) => w.volcanic, { minH: 1.0, maxSlope: 0.5, spacing: 4.5 }),
  S('cc0_cliff_b', 16, (w) => w.volcanic, { minH: 0.7, maxSlope: 0.95, spacing: 3 }),

  // — warm shores and the shallow sea
  S('palm_a', 8, (_w, temp) => warm(temp), { minH: 1.0, maxH: 4.5, maxSlope: 0.3, spacing: 5.5 }),
  S('palm_b', 6, (_w, temp) => warm(temp), { minH: 1.0, maxH: 4.5, maxSlope: 0.3, spacing: 5 }),
  S('cc0_log_long', 5, () => 1, { minH: 0.4, maxH: 2.4, maxSlope: 0.4, spacing: 4 }),
  S('beach_starfish', 30, (_w, temp) => warm(temp), { minH: 0.25, maxH: 1.6, maxSlope: 0.3, spacing: 1.6 }),
  // coral only ever grows under water, on the shallow floor
  S('coral_branch', 36, (_w, temp) => warm(temp), { minH: -1.8, maxH: -0.08, maxSlope: 0.6, spacing: 1.3 }),
  S('coral_brain', 18, (_w, temp) => warm(temp), { minH: -1.8, maxH: -0.08, maxSlope: 0.6, spacing: 1.6 }),
  S('coral_fan', 18, (_w, temp) => warm(temp), { minH: -1.6, maxH: -0.08, maxSlope: 0.6, spacing: 1.6 }),

  // — wildlife. Sparse by design: an animal should be an encounter, not a herd.
  //   The niche weight is what confines each species to its biome.
  S('cc0_deer', 2, (w) => w.meadow * 0.7 + w.forest * 0.6, { minH: 1.2, maxSlope: 0.35, spacing: 4 }),
  S('cc0_cow', 1, (w) => w.meadow * 0.8, { minH: 1.2, maxSlope: 0.3, spacing: 4 }),
  S('cc0_chicken', 3, (w, temp) => w.meadow * 0.7 + warm(temp) * 0.3, { minH: 1.0, maxH: 4.5, maxSlope: 0.35, spacing: 4 }),
  S('cc0_hedgehog', 3, (w) => w.forest * 0.7 + w.meadow * 0.5, { minH: 1.0, maxSlope: 0.4, spacing: 4 }),
  S('cc0_fox', 2, (w) => w.taiga * 0.8 + w.snow * 0.5, { minH: 1.1, maxSlope: 0.4, spacing: 4 }),
  S('cc0_cat', 1, (w, temp) => warm(temp) * 0.6 + w.meadow * 0.3, { minH: 1.0, maxH: 4.0, maxSlope: 0.3, spacing: 4 }),
  S('cc0_frog', 5, (w) => w.swamp * 0.9, { minH: 0.2, maxSlope: 0.5, spacing: 4 }),

  // — jungle: the rainforest undergrowth. Vines hang, ferns layer, the canopy is tall.
  S('cc0_broadleaf_c', 14, (w) => w.jungle * 0.95, { minH: 1.4, maxSlope: 0.45, spacing: 3.2 }),
  S('cc0_broadleaf_a', 11, (w) => w.jungle * 0.8, { minH: 1.4, maxSlope: 0.42, spacing: 3.4 }),
  S('cc0_bamboo_a', 9, (w) => w.jungle * 0.7, { minH: 1.3, maxSlope: 0.4, spacing: 2.6 }),
  S('cc0_vine', 20, (w) => w.jungle * 0.85, { minH: 1.2, maxSlope: 0.5, spacing: 2.0 }),
  S('cc0_fern_a', 38, (w) => w.jungle * 0.9, { minH: 1.1, maxSlope: 0.5, spacing: 1.4 }),
  S('cc0_fern_b', 26, (w) => w.jungle * 0.8, { minH: 1.0, maxSlope: 0.5, spacing: 1.5 }),
  S('cc0_mushroom_m', 28, (w) => w.jungle * 0.7 + w.swamp * 0.3, { minH: 1.1, maxSlope: 0.5, spacing: 1.6 }),
  S('cc0_grass_c', 240, (w) => w.jungle * 0.95, { minH: 1.2, maxSlope: 0.7, spacing: 0.9 }),

  // — badlands: banded clay, dry scrub, the odd skeleton tree
  S('cc0_painted_rock', 15, (w) => w.badlands * 0.95, { minH: 0.9, maxSlope: 0.9, spacing: 2.6 }),
  S('cc0_standing_c', 7, (w) => w.badlands * 0.8, { minH: 1.0, maxSlope: 0.7, spacing: 4 }),
  S('cc0_boulder_c', 10, (w) => w.badlands * 0.7 + w.desert * 0.3, { minH: 0.8, maxSlope: 0.9, spacing: 2.4 }),
  S('cc0_dead_b', 6, (w) => w.badlands * 0.85, { minH: 0.9, maxSlope: 0.5, spacing: 5 }),
  S('cc0_bush_d', 11, (w) => w.badlands * 0.75 + w.desert * 0.3, { minH: 0.9, maxSlope: 0.5, spacing: 2.6 }),
  S('cc0_grass_c', 80, (w) => w.badlands * 0.6, { minH: 1.0, maxSlope: 0.6, spacing: 1.6 }),
  S('desert_mesa', 3, (w) => w.badlands * 0.9, { minH: 1.2, maxSlope: 0.5, spacing: 7 }),

  // — tundra: moss, low willow, no tall trees
  S('cc0_bush_snow', 15, (w) => w.tundra * 0.9, { minH: 1.0, maxSlope: 0.5, spacing: 2.4 }),
  S('cc0_bush_e', 11, (w) => w.tundra * 0.8, { minH: 1.0, maxSlope: 0.5, spacing: 2.6 }),
  S('cc0_dead_snow', 4, (w) => w.tundra * 0.7 + w.taiga * 0.2, { minH: 1.0, maxSlope: 0.45, spacing: 5 }),
  S('cc0_grass_b', 150, (w) => w.tundra * 0.85, { minH: 0.9, maxSlope: 0.6, spacing: 1.0 }),
  S('cc0_snowrock_b', 11, (w) => w.tundra * 0.8, { minH: 0.8, maxSlope: 0.9, spacing: 2.6 }),
  S('cc0_boulder_b', 8, (w) => w.tundra * 0.6, { minH: 0.8, maxSlope: 0.9, spacing: 3 }),

  // — highland: thin grass over scree, the rock shows through
  S('cc0_broadleaf_d', 4, (w) => w.highland * 0.6, { minH: 1.6, maxSlope: 0.34, spacing: 5 }),
  S('cc0_bush_a', 9, (w) => w.highland * 0.7, { minH: 1.2, maxSlope: 0.45, spacing: 2.4 }),
  S('cc0_grass_a', 180, (w) => w.highland * 0.9, { minH: 1.2, maxSlope: 0.7, spacing: 0.95 }),
  S('cc0_boulder_e', 11, (w) => w.highland * 0.85, { minH: 0.9, maxSlope: 0.9, spacing: 2.6 }),
  S('cc0_cliff_a', 5, (w) => w.highland * 0.7, { minH: 1.0, maxSlope: 0.95, spacing: 4 }),
  S('cc0_flower_a', 36, (w) => w.highland * 0.5, { minH: 1.2, maxSlope: 0.4, spacing: 1.5 }),

  // — wildlife on the new ground
  S('cc0_deer', 2, (w) => w.jungle * 0.5 + w.highland * 0.6, { minH: 1.2, maxSlope: 0.4, spacing: 5 }),
  S('cc0_frog', 5, (w) => w.jungle * 0.8 + w.tundra * 0.1, { minH: 0.4, maxSlope: 0.5, spacing: 3 }),
  S('cc0_hedgehog', 2, (w) => w.badlands * 0.6 + w.highland * 0.4, { minH: 0.9, maxSlope: 0.4, spacing: 5 }),
  S('cc0_fox', 2, (w) => w.tundra * 0.85, { minH: 1.0, maxSlope: 0.4, spacing: 6 }),

  // — camp dressing left by travellers; only on beaches and meadows
  S('cc0_campfire', 1, (_w, temp) => warm(temp) * 0.7, { minH: 1.1, maxH: 3.0, maxSlope: 0.22, spacing: 4 }),
  S('cc0_barrel_a', 1, (_w, temp) => warm(temp) * 0.5, { minH: 1.1, maxH: 3.0, maxSlope: 0.3, spacing: 4 }),
  S('cc0_crate_a', 2, (_w, temp) => warm(temp) * 0.5, { minH: 1.1, maxH: 3.0, maxSlope: 0.3, spacing: 4 }),
  S('cc0_boat', 1, (_w, temp) => warm(temp) * 0.6, { minH: 0.9, maxH: 2.6, maxSlope: 0.25, spacing: 4 }),
  S('cc0_cart', 1, (w) => w.meadow * 0.4, { minH: 1.3, maxSlope: 0.25, spacing: 4 }),
  S('cc0_hay', 2, (w) => w.meadow * 0.5, { minH: 1.3, maxSlope: 0.3, spacing: 4 }),
];

/** One landmark at most per tile, whichever is most at home there. */
export const LANDMARKS: SpeciesRule[] = [
  S('cc0_ancient', 1, (w) => w.forest, { minH: 2.2, maxSlope: 0.25, spacing: 10, landmark: true }),
  S('cc0_rock_arch', 1, (w) => w.meadow, { minH: 1.8, maxSlope: 0.22, spacing: 9, landmark: true }),
  S('cc0_crystal_e', 1, (w) => w.snow, { minH: 2.0, maxSlope: 0.25, spacing: 9, landmark: true }),
  S('landmark_obelisk', 1, (w) => w.desert, { minH: 1.8, maxSlope: 0.25, spacing: 9, landmark: true }),
  S('cc0_giant_mushroom_a', 1, (w) => w.swamp, { minH: 0.6, maxSlope: 0.22, spacing: 10, landmark: true }),
  S('landmark_vent', 1, (w) => w.volcanic, { minH: 1.6, maxSlope: 0.3, spacing: 10, landmark: true }),
  S('landmark_ribs', 1, (_w, temp) => warm(temp) * 0.8, { minH: 0.8, maxSlope: 0.22, spacing: 9, landmark: true }),
];

export const DIRECTIONS8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/** Chinese compass name of a tile relative to the player (north = -z). */
export function compassName(dx: number, dz: number): string {
  const a = (Math.atan2(dx, -dz) + Math.PI * 2) % (Math.PI * 2);
  return DIRECTIONS8[Math.round(a / (Math.PI / 4)) % 8];
}
