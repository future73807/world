import * as THREE from 'three';
import { IslandField, DEFAULT_WORLD, worldWithSeed, WorldSettings, TILE, CHUNK, chunkKey, FrontierTile, TileState, TileSpec, SavedWorld, tileBounds, tileOf, connectTiles } from './world';
import {
  buildCliff,
  renderMinimapCanvas,
  mapPainter,
  MapPainter,
  TerrainChunks,
  WORLD_SPAN,
  chunkRange,
  isDeepSea,
  traceCoastLoops,
  CoastLoop,
  buildLavaPool,
  terrainMaterial,
  coastOutward,
} from './terrain';
import { buildSky, buildFarIslets, buildMistAlong, updateMistRing, setMistOpacity, buildFormingMist, updateFormingMist, MistStation } from './env';
import { compassName } from './biomes';
import { Water } from './water';
import { SwimFx } from './swimfx';
import { AssetLibrary, ModelEntry } from './assets';
import { PropSet, PropRenderer, scatterTile, PropInstance, Avoid } from './props';
import { revealTile } from './reveal';
import { aiApi, sleep, RegionPayload, RegionResult } from './aiClient';
import { PAL, SUN_DIR } from './palette';
import { Player } from './player';
import { lerp } from '../lib/noise';
import { ThirdPersonCamera } from './camera';
import { InputController } from './input';

export interface GameCallbacks {
  onRegion?: (name: string) => void;
  onMinimapReady?: (canvas: HTMLCanvasElement) => void;
  /** fires when a tile is generated (the count includes the birth block) */
  onRegionCount?: (n: number) => void;
  /** fires ~10x/s: position, camera yaw and locomotion state for HUD widgets */
  onTick?: (s: GameTick) => void;
  /** every change of the region-generation state machine */
  onGenerate?: (g: GenState) => void;
}

export interface GameTick {
  x: number;
  z: number;
  yaw: number;
  cameraYaw: number;
  speed: number;
  state: string;
  stamina: number;
  /** in water deep enough to swim in */
  inWater: boolean;
  /** the eye is under the surface: the world is seen through water */
  underwater: boolean;
}

/** Life cycle of one E-key region generation. */
export interface GenState {
  active: boolean;
  stage: string;
  detail: string;
  /** 0..1 */
  progress: number;
  tile: { x: number; z: number } | null;
  cancelled: boolean;
  error: string | null;
  lastResult: { name: string; sourceLabel: string; blenderUsed: boolean; models: number } | null;
}

const SPAWN = new THREE.Vector3(0, 0, 12);
const CLEAR_TINT = new THREE.Color(0xffffff);
const UNDERWATER_TINT = new THREE.Color(0x2a93a6);
const SAVE_KEY = 'mist.world.v1';
const BIRTH_SEED = DEFAULT_WORLD.seed;
/** how close (BU) to a frontier border the player must stand to open the tile beyond it */
const REACH = 10;
/** chunks around a new tile whose ground can change (the tile blend is ~6 BU wide) */
const BLEND_CHUNKS = 5;

const _openingFocus = new THREE.Vector3();

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private input: InputController;
  private player!: Player;
  private cam!: ThirdPersonCamera;
  private field!: IslandField;
  /** the sea and the lakes; created once the field exists */
  private water: Water | null = null;
  /** ripples and bubbles around the slime */
  private swimFx = new SwimFx();
  /** the eye is under the surface: the world is seen through water */
  underwater = false;
  /**
   * The opening mist: 1 while it still covers the world, easing to 0 as it parts
   * onto the island. There is no loading screen over the game — the game is on
   * screen from the first moment, behind its own fog and a few drifting clouds.
   */
  private veil = 1;
  private veilOpening = false;
  private bootRaf = 0;
  private bootLast = 0;
  private mistTime = 0;
  /** clouds drifting over the island while it is being made; they thin out as the mist parts */
  private bootMist: THREE.Group[] = [];
  /** the opening shot: the eye starts high and far back, and settles down onto the slime */
  private static readonly OPEN_PITCH = 0.5;
  private static readonly OPEN_DISTANCE = 22;
  /** the map being painted a few rows per frame while the mist parts */
  private mapBake: MapPainter | null = null;
  private clock = new THREE.Clock();
  private cbs: GameCallbacks;
  private frozen = false;
  private disposed = false;

  private chunks!: TerrainChunks;
  private cliffGroup = new THREE.Group();
  private coastLoops: CoastLoop[] = [];
  /** the frontier mist, laid along every shore that faces the unknown */
  private mistGroup: THREE.Group | null = null;
  private mistIn = 1;
  private mistOld: { g: THREE.Group; t: number }[] = [];
  /** swirl of puffs inside a tile while it is being generated */
  private forming: THREE.Group | null = null;
  /** outline of the tile the camera is aimed at (the next one to open) */
  private tileFrame!: THREE.Group;
  private tileFrameOn = false;
  private lava: THREE.Mesh[] = [];
  private terrainMat = terrainMaterial();
  /** terrain meshes condensing out of the mist */
  private reveals: { mat: THREE.MeshStandardMaterial; t: number; dur: number; mesh: THREE.Mesh }[] = [];

  readonly library = new AssetLibrary();
  private props = new PropSet();
  private propRenderer: PropRenderer;
  private birthGeos = new Map<string, THREE.BufferGeometry>();
  private birthHeights = new Map<number, Float32Array>();
  private missingModels = new Set<string>();

  /** objects that belong to the current world (cleared on reset), unlike sky/sea */
  private worldParts: THREE.Object3D[] = [];
  private worldRoot = new THREE.Group();
  private world: WorldSettings = DEFAULT_WORLD;

  private currentRegion = '';
  private regionCooldown = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastFps = 0;
  private minimap: HTMLCanvasElement | null = null;
  private minimapSpan = WORLD_SPAN;
  private fogLayers: THREE.Mesh[] = [];
  private tickAccum = 0;
  private fog!: THREE.Fog;
  /** the shadow-casting sun; its box travels with the player */
  private sun!: THREE.DirectionalLight;
  /** where the sun's shadow box was last centred, snapped to whole BU */
  private sunAt = { x: 1e9, z: 1e9 };
  private host: HTMLElement;
  private settings = {
    renderPrecision: 1.5,
    resolution: 1,
    fpsCap: 0,
    shadows: true,
    vegetationDensity: 'full' as 'full' | 'sparse',
    fogDistance: 60,
    lookSensitivity: 1,
    invertY: false,
    cameraDistance: 7.4,
    movementAssist: false,
    coneDeg: 60,
  };
  fpsCap = 0;
  /**
   * Analytic occluders: every tree/rock keeps a cheap cylinder so the camera can
   * test the whole focus→eye segment without raycasting merged instanced geometry.
   */
  private blockers: { x: number; z: number; r: number; top: number }[] = [];
  private occlTimer = 0;
  /** fog-of-war mask for the maps: opaque mist, clear where the world has been seen */
  exploredCanvas: HTMLCanvasElement | null = null;
  private exploredCtx: CanvasRenderingContext2D | null = null;
  private exploredSpan = WORLD_SPAN;
  private exploredTimer = 0;
  /** counts every change to the mask: the map widgets rebuild their fog when it moves */
  fogStamp = 0;
  private boundsProbe: HTMLCanvasElement | null = null;
  /** screen-space position of the world-anchored E prompt, updated every frame */
  mistPrompt = { x: 0, y: 0, visible: false, inRange: false, dist: 0, ax: 0, az: 0 };
  /** the ungenerated tile the camera is aimed at, and the point on its border nearest the player */
  frontier = { target: null as FrontierTile | null, ax: 0, az: 0, dist: 0, angle: 0, direction: '' };
  /** screen anchor for the world-attached stamina ribbon above the slime */
  staminaHud = { x: 0, y: 0, visible: false };
  /** world-anchored progress badge of a running generation */
  genHud = { x: 0, y: 0, visible: false };
  gen: GenState = { active: false, stage: '', detail: '', progress: 0, tile: null, cancelled: false, error: null, lastResult: null };
  private genCancel = false;
  /** the server job behind the generation in progress (so a cancel can stop it there too) */
  private genJob: string | null = null;
  private genAnchor = { x: 0, z: 0 };

  constructor(canvasHost: HTMLElement, input: InputController, cbs: GameCallbacks = {}) {
    this.cbs = cbs;
    this.input = input;
    this.host = canvasHost;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      // transparent canvas: the cartoon sky is the host's painted CSS gradient
      // behind the world — pure texture/effect, no dome geometry, no wash
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(canvasHost.clientWidth, canvasHost.clientHeight);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvasHost.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, canvasHost.clientWidth / canvasHost.clientHeight, 0.1, 900);
    // heavy mist: the world dissolves into cloud at the fog distance, so nothing
    // ahead is readable until you walk into it
    this.fog = new THREE.Fog(0xffffff, 24, this.settings.fogDistance);
    this.scene.fog = this.fog;

    this.scene.add(this.worldRoot);
    this.propRenderer = new PropRenderer(this.library);

    this.buildLights();
    this.buildEnvironment();
    this.buildTileFrame();

    // diagnostic framing only (used for art-review screenshots); never reachable from gameplay UI
    if (typeof location !== 'undefined') {
      const preset = new URLSearchParams(location.search).get('cam');
      this.camPreset = preset;
    }
  }

  /** Builds the world. Resolves once the first frame can be drawn. */
  static async create(host: HTMLElement, input: InputController, cbs: GameCallbacks = {}, onBoot?: (text: string) => void): Promise<Game> {
    const g = new Game(host, input, cbs);
    await g.init(onBoot);
    return g;
  }

  private camPreset: string | null = null;

  private async init(onBoot?: (text: string) => void) {
    // The world goes on screen at once — sky, haze and a few clouds drifting over
    // the place the island will rise from — and the loading text sits over it.
    this.startBootLoop();
    try {
      onBoot?.('正在加载 Blender 模型库…');
      const [count] = await Promise.all([
        this.library.loadPrefabs().catch((e) => {
          console.error('[assets] prefab library could not be loaded', e);
          return 0;
        }),
        this.loadBirthTerrain(),
      ]);
      this.ensureField();
      const restored = await this.restoreBuiltModels();
      await this.buildWorld(onBoot, count, restored);
    } finally {
      this.stopBootLoop();
    }
  }

  /**
   * One frame's wait between the stages of the world build, so the mist keeps
   * moving and the loading text can change while the island is made. A hidden tab
   * never asks for a frame, so the wait also ends on a timer.
   */
  private static async beat(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 60);
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Draws the unfinished world while it is being made: sky, haze, and the clouds over the island. */
  private startBootLoop() {
    this.bootLast = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - this.bootLast) / 1000);
      this.bootLast = now;
      this.updateOpeningMist(dt);
      if (!this.cam) this.placeOpeningEye(_openingFocus.set(0, this.field ? this.field.height(0, 12) : 2.3, 12));
      this.renderer.render(this.scene, this.camera);
      this.bootRaf = requestAnimationFrame(tick);
    };
    this.bootRaf = requestAnimationFrame(tick);
  }

  private stopBootLoop() {
    cancelAnimationFrame(this.bootRaf);
    this.bootRaf = 0;
  }

  /** Where the opening shot looks from, before the gameplay camera exists to place it. */
  private placeOpeningEye(focus: THREE.Vector3) {
    const yaw = this.cam ? this.cam.yaw : 0;
    const cp = Math.cos(Game.OPEN_PITCH);
    this.camera.position.copy(focus).addScaledVector(new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(Game.OPEN_PITCH), Math.cos(yaw) * cp), Game.OPEN_DISTANCE);
    this.camera.lookAt(focus.x, focus.y + 0.92, focus.z);
  }

  /**
   * The mist, every frame: the slow haze layers always drift; while the opening
   * veil is up the fog lies close and the clouds over the island turn, and once
   * the world is made the veil lifts, the fog with it, and the clouds thin out.
   */
  private updateOpeningMist(dt: number) {
    this.mistTime += dt;
    const t = this.mistTime;
    for (let i = 0; i < this.fogLayers.length; i++) {
      const m = this.fogLayers[i];
      m.rotation.y = t * (0.006 + i * 0.003);
      m.position.y = 2 + i * 3 + Math.sin(t * 0.24 + i) * 0.3;
    }
    if (!this.bootMist.length) return;
    if (this.veilOpening) this.veil = Math.max(0, this.veil - dt / 2.8);
    const k = this.veil * this.veil * (3 - 2 * this.veil); // smoothstep: it lingers, then clears quickly
    this.fog.near = lerp(24, 6, k);
    this.fog.far = lerp(this.settings.fogDistance, 46, k);
    this.fog.color.copy(CLEAR_TINT);
    const eye = this.veil < 0.999 ? this.camera.position : undefined;
    for (const g of this.bootMist) {
      updateFormingMist(g, t, eye);
      for (const child of g.children) (child as THREE.Sprite).material.opacity *= Math.min(1, this.veil * 1.6);
    }
  }

  /**
   * The birth island's terrain as the Blender project exported it: chunk meshes
   * plus the height grid of each chunk (so hand edits in the .blend are what the
   * slime walks on). Absent files simply fall back to browser-built meshes.
   */
  private async loadBirthTerrain() {
    try {
      const res = await fetch('/terrain/birth_index.json');
      if (!res.ok) return;
      const idx = (await res.json()) as { seed: number; grid: number; chunks: [number, number][] };
      if (idx.seed !== BIRTH_SEED) return;
      const [geos, buf] = await Promise.all([
        this.library.loadTerrain('/terrain/birth.glb'),
        fetch('/terrain/birth_heights.bin').then((r) => r.arrayBuffer()),
      ]);
      const all = new Float32Array(buf);
      const n = idx.grid * idx.grid;
      idx.chunks.forEach(([cx, cz], k) => {
        const g = geos.get(`${cx},${cz}`);
        if (g) this.birthGeos.set(`${cx},${cz}`, g);
        this.birthHeights.set(chunkKey(cx, cz), all.slice(k * n, k * n + n));
      });
      console.info(`[terrain] ${this.birthGeos.size} chunks from Blender (${idx.grid}×${idx.grid} heights each)`);
    } catch (e) {
      console.info('[terrain] no Blender export found, building terrain in the browser', e);
    }
  }

  /**
   * Models Blender built for regions of an earlier session are fetched again by
   * the address the save kept for them. A file that is gone only costs that model.
   */
  private async restoreBuiltModels(): Promise<number> {
    const byId = new Map<string, ModelEntry>();
    for (const t of this.field.list()) for (const m of t.spec.built ?? []) byId.set(m.id, m);
    if (!byId.size) return 0;
    const done = await Promise.all(
      [...byId.values()].map((m) =>
        this.library.loadGenerated(m, m.url ?? '').catch((e) => {
          console.warn(`[assets] the model Blender built for an earlier session, "${m.id}", is no longer available`, e);
          return null;
        }),
      ),
    );
    const n = done.filter(Boolean).length;
    console.info(`[assets] ${n}/${byId.size} models built for earlier regions restored from the save`);
    return n;
  }

  /** True while nothing that could change a chunk's ground has been generated near it since the export. */
  private isBirthChunk(cx: number, cz: number): boolean {
    const pad = CHUNK * 0.5 + TILE * 0.66;
    const x0 = cx * CHUNK - pad;
    const x1 = cx * CHUNK + pad;
    const z0 = cz * CHUNK - pad;
    const z1 = cz * CHUNK + pad;
    for (let tz = Math.round(z0 / TILE); tz <= Math.round(z1 / TILE); tz++) {
      for (let tx = Math.round(x0 / TILE); tx <= Math.round(x1 / TILE); tx++) {
        const t = this.field.get(tx, tz);
        if (!t) continue; // still open sea, exactly as when the island was exported
        // a birth tile counts only while nothing has steered or reshaped it
        const s = t.spec;
        if (s.source !== 'preset') return false;
        if (s.biome !== undefined || s.peak !== undefined || s.rough !== undefined || s.land !== undefined || s.props || s.extra || s.feature || s.bridge) return false;
      }
    }
    return true;
  }

  // --------------------------------------------------------------------------- world build

  private addPart(o: THREE.Object3D) {
    this.worldRoot.add(o);
    this.worldParts.push(o);
  }

  private removePart(o: THREE.Object3D) {
    const i = this.worldParts.indexOf(o);
    if (i >= 0) this.worldParts.splice(i, 1);
    this.worldRoot.remove(o);
    disposeTree(o);
  }

  private clearParts() {
    for (const o of this.worldParts) {
      this.worldRoot.remove(o);
      disposeTree(o);
    }
    this.worldParts = [];
    this.mistGroup = null;
    this.forming = null;
    this.lava = [];
    this.reveals = [];
    this.mistOld = [];
  }

  /**
   * Builds the whole world in stages. With `onBoot` given (the first build) each
   * stage hands a frame back, so the mist keeps drifting and the loading text
   * follows the work; without it the stages run straight through.
   */
  private async buildWorld(onBoot?: (text: string) => void, loaded = 0, restored = 0): Promise<void> {
    const staged = !!onBoot;
    const beat = staged ? () => Game.beat() : () => Promise.resolve();
    const say = onBoot ?? (() => {});
    const opening = this.veil > 0; // the first build: the world appears as the mist parts
    this.mapBake = null;
    this.clearParts();
    this.props.clear();
    this.terrainMat = terrainMaterial();
    this.chunks = new TerrainChunks(this.field);
    this.addPart(this.chunks.group);
    this.addPart((this.cliffGroup = new THREE.Group()));
    this.propRenderer.sync(this.props);
    this.addPart(this.propRenderer.group);

    // the character: spawn on dry, level ground near the middle of the forest tile
    const spawn = this.findSpawn();
    this.spawn = spawn;
    // every tile must be enterable on foot from the spawn: islands and lagoon
    // tiles get a sand causeway to the nearest ground the player can already reach
    connectTiles(this.field, spawn.x, spawn.z);

    // terrain: browser-built everywhere, then the Blender export replaces the
    // chunks it is still valid for
    say(`已载入 ${loaded} 个 Blender 模型${restored ? `，找回 ${restored} 个新造的模型` : ''}，正在铺开地形…`);
    await beat();
    const r = chunkRange(this.field.list(), 1);
    for (let j = r.z0; j <= r.z1; j++) {
      for (let i = r.x0; i <= r.x1; i++) {
        if (this.chunks.has(i, j) || isDeepSea(this.field, i, j)) continue;
        this.chunks.buildChunk(i, j);
      }
      if (staged && j % 2 === 0) await beat();
    }
    if (this.world.seed === BIRTH_SEED) {
      for (const [k, g] of this.birthGeos) {
        const [cx, cz] = k.split(',').map(Number);
        if (!this.chunks.has(cx, cz) || !this.isBirthChunk(cx, cz)) continue;
        this.chunks.useImported(cx, cz, g);
        const h = this.birthHeights.get(chunkKey(cx, cz));
        if (h) this.field.setHeights(cx, cz, h);
      }
    }

    this.rebuildShore();
    this.rebuildMist(true);
    this.ensureWater();
    await beat();

    if (this.player) this.scene.remove(this.player.group);
    this.player = new Player(this.field, spawn);
    this.player.boundaryRadius = 1e5; // the sea is the boundary; tiles are not walled
    this.scene.add(this.player.group);
    this.cam = new ThirdPersonCamera(this.field, this.camera);
    this.applyCameraSettings();
    if (opening) {
      // no jump at the hand-over: the gameplay eye starts exactly where the opening eye was
      this.placeOpeningEye(this.player.pos);
      this.cam.begin(this.cam.yaw, Game.OPEN_PITCH, Game.OPEN_DISTANCE);
    }
    this.cam.snap(this.player.pos);
    if (this.camPreset === 'wide') this.cam.frame(Math.PI * 0.86, 0.34, 13.2);
    else if (this.camPreset === 'low') this.cam.frame(Math.PI, 0.06, 5.2);
    else if (this.camPreset === 'high') this.cam.frame(Math.PI * 0.94, 0.72, 11.5);

    say('地形铺好了，正在种下树木与花草…');
    await beat();
    await this.scatterAll(beat);
    this.refreshLava();
    this.propRenderer.update(this.player.pos.x, this.player.pos.z, true);

    // the first map is painted a few rows per frame while the mist parts (see update())
    this.minimapSpan = WORLD_SPAN;
    this.minimap = staged ? null : renderMinimapCanvas(this.field, 1024, this.minimapSpan);
    if (staged) this.mapBake = mapPainter(this.field, 1024, this.minimapSpan, 0, 0, true);
    this.initExploredMask();
    // (no map yet while it is being painted: the HUD is told when the last row lands)
    if (this.minimap) this.cbs.onMinimapReady?.(this.minimap);
    this.cbs.onRegionCount?.(this.regionCount);
    this.currentRegion = this.field.regionName(this.player.pos.x, this.player.pos.z);
    this.cbs.onRegion?.(this.currentRegion);
    this.frameTile(null);
  }

  private spawn = SPAWN.clone();

  private findSpawn(): THREE.Vector3 {
    const ok = (x: number, z: number) => {
      const h = this.field.height(x, z);
      return h > 1.0 && h < 7 && this.field.slope(x, z) < 0.32;
    };
    if (ok(SPAWN.x, SPAWN.z)) return SPAWN.clone();
    for (let r = 2; r <= 16; r += 1.5) {
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = SPAWN.z + Math.sin(a) * r;
        if (ok(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    return SPAWN.clone();
  }

  private rebuildShore() {
    while (this.cliffGroup.children.length) {
      const old = this.cliffGroup.children.pop() as THREE.Mesh;
      old.geometry?.dispose();
      (old.material as THREE.Material | undefined)?.dispose();
    }
    const b = tileBounds(this.field.list(), 6);
    this.coastLoops = traceCoastLoops(this.field, b, 1);
    const cliff = buildCliff(this.coastLoops, this.world.seed);
    if (cliff) this.cliffGroup.add(cliff);
  }

  /**
   * Mist along every shore that faces an ungenerated tile. When the frontier
   * moves, the old bank dissolves while the new one condenses, so the fog is
   * seen to roll back rather than jump.
   */
  private rebuildMist(instant: boolean) {
    const stations: MistStation[] = [];
    const o = new THREE.Vector2();
    for (const loop of this.coastLoops) {
      const n = loop.pts.length - 1;
      let carried = 0;
      for (let i = 0; i < n; i++) {
        const p = loop.pts[i];
        const q = loop.pts[i + 1];
        carried += p.distanceTo(q);
        if (carried < 4.2) continue;
        carried = 0;
        // ponds, lily pools and pebble-sized islets do not need a frontier of their own
        if (!loop.open[i] || loop.length < 24) continue;
        coastOutward(loop, i, o);
        const [tx, tz] = tileOf(p.x + o.x * 9, p.y + o.y * 9);
        if (this.field.get(tx, tz)) continue; // known water on the other side
        stations.push({ x: p.x, z: p.y, nx: o.x, nz: o.y });
      }
    }
    const g = buildMistAlong(stations, this.world.seed + 911);
    this.addPart(g);
    if (this.mistGroup) {
      if (instant) this.removePart(this.mistGroup);
      else this.mistOld.push({ g: this.mistGroup, t: 0 });
    }
    this.mistGroup = g;
    this.mistIn = instant ? 1 : 0;
    if (!instant) setMistOpacity(g, 0);
  }

  private plantTile(tile: TileState, avoid: Avoid[]): PropInstance[] {
    const { placed, missing } = scatterTile(this.field, tile, this.library, this.props, this.world.seed * 7919 + tile.key * 31 + 17, avoid);
    for (const m of missing) this.missingModels.add(m);
    this.props.add(tile.key, placed);
    return placed;
  }

  private async scatterAll(beat: () => Promise<void> = () => Promise.resolve()) {
    this.props.clear();
    // keep the spawn clearing and the opening camera line free of trunks and
    // boulders; grass and flowers may still grow right up to the slime
    const avoid: Avoid[] = [
      { x: this.spawn.x, z: this.spawn.z, r: 7.5, solidOnly: true },
      { x: 0, z: 19.5, r: 5, solidOnly: true },
      { x: this.spawn.x, z: this.spawn.z, r: 1.6 },
    ];
    const tiles = this.field.list();
    for (let i = 0; i < tiles.length; i++) {
      this.plantTile(tiles[i], avoid);
      if (i % 2 === 1) await beat();
    }
    this.propRenderer.sync(this.props);
    this.refreshBlockers();
    if (this.missingModels.size) console.warn('[props] recipes reference models missing from the library:', [...this.missingModels]);
  }

  private refreshBlockers() {
    this.blockers = [];
    for (const p of this.props.all) {
      if (!p.solid) continue;
      // a model on several feet blocks at each foot; the opening between them is open
      if (p.shape) for (const c of p.shape) this.blockers.push(c);
      else this.blockers.push({ x: p.x, z: p.z, r: p.r, top: p.top });
    }
    if (this.player) this.player.colliders = this.blockers;
  }

  private refreshLava() {
    for (const m of this.lava) this.removePart(m);
    this.lava = [];
    for (const t of this.field.list()) {
      const pool = this.field.lavaPool(t);
      if (pool) {
        const m = buildLavaPool(pool);
        this.lava.push(m);
        this.addPart(m);
      }
    }
  }

  // --------------------------------------------------------------------------- lights & sky

  private buildLights() {
    // Bright midday key with cool sky fill — high-key, with crisp short contact
    // shadows rather than a moody teal wash.
    const sun = new THREE.DirectionalLight(0xfff6e0, 2.15);
    sun.position.set(SUN_DIR.x * 60, SUN_DIR.y * 70, SUN_DIR.z * 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    const s = 42;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.14;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.scene.add(new THREE.HemisphereLight(0xcfeaff, 0x6f8a5c, 0.85));
    const fill = new THREE.DirectionalLight(0xb8dcf5, 0.38);
    fill.position.set(-30, 22, -40);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfff0cf, 0.42);
    rim.position.set(24, 30, -55);
    this.scene.add(rim);
    this.scene.add(this.swimFx.group);
  }

  /** The sea is made once and follows the field from then on: a new world means new depths. */
  private ensureWater() {
    if (!this.water) {
      this.water = new Water(this.field);
      this.water.setReach(this.settings.fogDistance);
      this.scene.add(this.water.group);
    } else {
      this.water.setField(this.field);
    }
    this.water.refreshAll();
  }

  /**
   * Air or water. Under the surface the world is seen through water: a teal haze
   * that closes in within a few steps, easing in and out as the eye crosses y = 0
   * (on land the ground keeps the eye above that).
   */
  private updateWaterFog(dt: number) {
    const under = this.camera.position.y < 0;
    this.underwater = under;
    const k = 1 - Math.exp(-dt * (under ? 10 : 4));
    // while the opening mist is up it owns the fog (updateOpeningMist writes it directly)
    const v = this.veil * this.veil * (3 - 2 * this.veil);
    const near = lerp(under ? 0.3 : 24, 6, v);
    const far = lerp(under ? 34 : this.settings.fogDistance, 46, v);
    this.fog.near += (near - this.fog.near) * k;
    this.fog.far += (far - this.fog.far) * k;
    this.fog.color.lerp(under ? UNDERWATER_TINT : CLEAR_TINT, k);
  }

  private buildEnvironment() {
    this.worldRoot.add(buildSky());
    this.worldRoot.add(buildFarIslets(this.world.seed));

    // the opening clouds: banks of mist drifting over the island while it is made
    for (const [x, z, seed] of [
      [0, 4, 515],
      [-20, -12, 733],
      [22, -8, 947],
      [4, 24, 1217],
    ]) {
      const bank = buildFormingMist(x, z, seed);
      this.bootMist.push(bank);
      this.worldRoot.add(bank);
    }

    for (let i = 0; i < 3; i++) {
      const geo = new THREE.CylinderGeometry(52 + i * 16, 60 + i * 18, 22 + i * 9, 64, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: PAL.mist,
        transparent: true,
        opacity: 0.075 - i * 0.016,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.y = 2 + i * 3;
      m.renderOrder = -1;
      this.fogLayers.push(m);
      this.worldRoot.add(m);
    }
  }

  private buildTileFrame() {
    const g = new THREE.Group();
    g.name = 'Tile_Frame';
    const half = TILE / 2 - 0.2;
    const pts = [
      new THREE.Vector3(-half, 0, -half),
      new THREE.Vector3(half, 0, -half),
      new THREE.Vector3(half, 0, half),
      new THREE.Vector3(-half, 0, half),
      new THREE.Vector3(-half, 0, -half),
    ];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false, fog: false }),
    );
    line.renderOrder = 30;
    g.add(line);
    // corner ticks rising out of the water, so the square reads in 3D and not only from above
    const tickPts: THREE.Vector3[] = [];
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      tickPts.push(new THREE.Vector3(sx * half, 0, sz * half), new THREE.Vector3(sx * half, 3.2, sz * half));
    }
    const ticks = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(tickPts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, fog: false }),
    );
    ticks.renderOrder = 30;
    g.add(ticks);
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE - 0.4, TILE - 0.4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false, fog: false }),
    );
    fill.renderOrder = 29;
    g.add(fill);
    g.visible = false;
    this.tileFrame = g;
    this.scene.add(g);
  }

  /** Shows the outline of tile (x, z), or hides it. `hot` = a generation is running on it. */
  private frameTile(tile: { x: number; z: number } | null, hot = false) {
    if (!tile) {
      this.tileFrame.visible = false;
      this.tileFrameOn = false;
      return;
    }
    this.tileFrame.visible = true;
    this.tileFrameOn = true;
    this.tileFrame.position.set(tile.x * TILE, hot ? 0.2 : 0.7, tile.z * TILE);
    this.tileFrame.userData.hot = hot;
  }

  // --------------------------------------------------------------------------- frame

  /** Called every frame by the React shell (dt already fps-capped). */
  update(dtRaw: number) {
    if (this.disposed || !this.player) return;
    const dt = Math.min(0.05, dtRaw);
    const intent = this.input.poll();
    const t = this.clock.elapsedTime;

    // the frontier mist drifts
    if (this.mistGroup) {
      updateMistRing(this.mistGroup, t);
      if (this.mistIn < 1) {
        this.mistIn = Math.min(1, this.mistIn + dt / 1.4);
        const e = 1 - Math.pow(1 - this.mistIn, 2);
        setMistOpacity(this.mistGroup, e);
      }
    }
    for (let i = this.mistOld.length - 1; i >= 0; i--) {
      const o = this.mistOld[i];
      o.t += dt;
      const k = Math.max(0, 1 - o.t / 2.6);
      setMistOpacity(o.g, k * k);
      if (k <= 0) {
        this.removePart(o.g);
        this.mistOld.splice(i, 1);
      }
    }
    if (this.forming) updateFormingMist(this.forming, t, this.camera.position);

    // new terrain condenses out of the mist: it starts as flat mist-white and
    // its own colour develops over ~2 s
    for (let i = this.reveals.length - 1; i >= 0; i--) {
      const r = this.reveals[i];
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      r.mat.emissiveIntensity = 1 - (1 - Math.pow(1 - k, 3));
      if (k >= 1) {
        r.mesh.material = this.terrainMat;
        r.mat.dispose();
        this.reveals.splice(i, 1);
      }
    }
    for (const m of this.lava) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.45 + Math.sin(t * 1.9) * 0.3 + Math.sin(t * 4.7) * 0.08;
    }

    // the world was made under mist: from the first gameplay frame on it parts, and
    // the eye settles down from the opening shot onto the slime
    if (!this.veilOpening && this.cam) this.veilOpening = true;
    this.updateOpeningMist(dt);
    if (this.mapBake && this.mapBake.step(40)) {
      this.minimap = this.mapBake.finish();
      this.mapBake = null;
      this.cbs.onMinimapReady?.(this.minimap);
    }
    // nothing moves the slime while the mist is still parting
    const held = this.frozen || this.veil > 0.001;
    if (!held) {
      this.cam.handleLook(intent.lookX, intent.lookY);
      this.cam.handleZoom(this.input.consumeWheel());
      this.player.update(dt, intent, this.cam.movementYaw, false);
    } else {
      this.player.update(dt, intent, this.cam.movementYaw, true);
    }
    this.cam.ease = lerp(1, 0.2, this.veil * this.veil);

    // sprint feedback: widen the lens / pull back, so speed is visible. This
    // must be set BEFORE cam.update, or the camera always lags one frame.
    this.cam.sprintAmount = this.player.sprintAmount;
    this.cam.update(dt, this.player.pos);
    this.followSun();
    this.resolveCameraOcclusion(dt);
    if (this.water) this.water.update(dt, this.player.pos.x, this.player.pos.z, this.camera, this.fog);
    this.updateWaterFog(dt);
    if (this.veil <= 0 && this.bootMist.length) {
      for (const g of this.bootMist) this.removePart(g);
      this.bootMist = [];
    }
    // what the water does around the slime: the splash, its ripples, its bubbles

    // fog of war: reveal around the player (throttled)
    this.exploredTimer -= dt;
    if (this.exploredCtx && this.exploredTimer <= 0) {
      this.exploredTimer = 0.4;
      this.stampExplored(this.player.pos.x, this.player.pos.z, 17, this.exploredCtx, this.exploredCanvas!.width);
    }

    this.propRenderer.update(this.player.pos.x, this.player.pos.z);
    this.updatePropFade(dt);
    this.updateFrontier(t);
    this.updateStaminaHud();
    this.updateGenHud();

    // region name + HUD tick (10 Hz — the 3D loop stays uncoupled)
    this.regionCooldown -= dt;
    this.tickAccum += dt;
    if (this.regionCooldown <= 0) {
      this.regionCooldown = 1.2;
      const name = this.field.regionName(this.player.pos.x, this.player.pos.z);
      if (name !== this.currentRegion) {
        this.currentRegion = name;
        this.cbs.onRegion?.(name);
      }
    }
    if (this.tickAccum >= 0.1) {
      this.tickAccum = 0;
      this.cbs.onTick?.({
        x: this.player.pos.x,
        z: this.player.pos.z,
        yaw: this.player.yaw,
        cameraYaw: this.cam.yaw,
        speed: this.player.speed,
        state: this.player.state,
        stamina: this.player.stamina,
        inWater: this.player.inWater,
        underwater: this.underwater,
      });
    }

    this.renderer.render(this.scene, this.camera);

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum > 0.5) {
      this.lastFps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }

  /**
   * Camera occlusion fade, per instance: only the trunks and crowns actually
   * crossing the eye→slime sight line fade to a whisper; everyone else stays solid.
   */
  private updatePropFade(dt: number) {
    const c = this.camera.position;
    const p = this.player.pos;
    const ax = c.x;
    const ay = c.y;
    const az = c.z;
    const dx = p.x - ax;
    const dy = p.y + 0.5 - ay;
    const dz = p.z - az;
    const len2 = dx * dx + dz * dz || 1e-6;
    for (const m of this.propRenderer.fadeMeshes) {
      const occ = m.userData.occ as PropInstance[] | undefined;
      if (!occ) continue;
      const fades = m.userData.fades as Float32Array;
      let dirty = false;
      const count = m.count;
      for (let i = 0; i < count; i++) {
        const q = occ[i];
        let next: number;
        if (q.hold > 0) {
          q.hold -= dt; // staggered reveal of a freshly generated region
          next = 0;
        } else {
          // nearest point on the sight line (horizontal projection) + a height test
          const tt = Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.z - az) * dz) / len2));
          const px = ax + dx * tt;
          const pz = az + dz * tt;
          const py = ay + dy * tt;
          const rr = q.crownR * 1.15;
          // (a) the sight line crosses the crown
          let blocked = (q.x - px) * (q.x - px) + (q.z - pz) * (q.z - pz) < rr * rr && py < q.top && py > q.top - 6.5 && tt > 0.02 && tt < 0.99;
          // (b) the eye itself sits inside the crown
          if (!blocked && rr > 0) {
            const ex = q.x - ax;
            const ez = q.z - az;
            if (ex * ex + ez * ez < rr * rr && ay < q.top && ay > q.top - 6.5) blocked = true;
          }
          next = THREE.MathUtils.lerp(q.fade, blocked ? 0.22 : 1, Math.min(1, dt * 9));
        }
        if (Math.abs(next - q.fade) > 0.001) dirty = true;
        q.fade = next;
        fades[i] = next;
      }
      if (dirty) (m.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /**
   * Decides which ungenerated tile E would open: among the frontier borders
   * within REACH of the player, the one closest to the camera's line of sight,
   * as long as it lies inside a fixed cone in front of the camera.
   */
  private updateFrontier(t: number) {
    const px = this.player.pos.x;
    const pz = this.player.pos.z;
    const fx = -Math.sin(this.cam.yaw);
    const fz = -Math.cos(this.cam.yaw);

    if (this.gen.active) {
      // locked on the tile being generated, wherever the player looks
      this.mistPrompt.visible = false;
      this.mistPrompt.inRange = false;
      if (this.tileFrameOn) this.pulseFrame(0.75 + Math.sin(t * 5) * 0.25);
      return;
    }

    let best: { tile: FrontierTile; ax: number; az: number; dist: number; ang: number } | null = null;
    const half = (this.settings.coneDeg * Math.PI) / 360;
    for (const f of this.field.frontier()) {
      for (const nb of f.touches) {
        // the shared border is a 40 BU line; take the point on it nearest the player
        const alongX = f.z !== nb.z;
        const ux = alongX ? 1 : 0;
        const uz = alongX ? 0 : 1;
        const s = Math.max(-TILE / 2, Math.min(TILE / 2, (px - nb.midX) * ux + (pz - nb.midZ) * uz));
        const ax = nb.midX + ux * s;
        const az = nb.midZ + uz * s;
        const dx = ax - px;
        const dz = az - pz;
        const dist = Math.hypot(dx, dz);
        if (dist > REACH) continue;
        const ang = dist > 0.5 ? Math.abs(Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz)) : 0;
        if (ang > half) continue;
        if (!best || ang + dist * 0.02 < best.ang + best.dist * 0.02) best = { tile: f, ax, az, dist, ang };
      }
    }

    if (!best) {
      this.frontier.target = null;
      this.mistPrompt.visible = false;
      this.mistPrompt.inRange = false;
      this.frameTile(null);
      return;
    }
    this.frontier.target = best.tile;
    this.frontier.ax = best.ax;
    this.frontier.az = best.az;
    this.frontier.dist = best.dist;
    this.frontier.angle = best.ang;
    this.frontier.direction = compassName(best.ax - px, best.az - pz);
    this.frameTile({ x: best.tile.x, z: best.tile.z });
    this.pulseFrame(0.55 + Math.sin(t * 3.2) * 0.2);

    this.mistPrompt.inRange = true;
    const y = Math.max(this.field.height(best.ax, best.az), 0) + 1.15;
    const v = new THREE.Vector3(best.ax, y, best.az).project(this.camera);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.mistPrompt.x = (v.x * 0.5 + 0.5) * size.x;
    this.mistPrompt.y = (-v.y * 0.5 + 0.5) * size.y;
    this.mistPrompt.visible = v.z < 1 && this.mistPrompt.x > -120 && this.mistPrompt.y > -120 && this.mistPrompt.x < this.host.clientWidth + 120 && this.mistPrompt.y < this.host.clientHeight + 120;
    this.mistPrompt.dist = best.dist;
    this.mistPrompt.ax = best.ax;
    this.mistPrompt.az = best.az;
  }

  private pulseFrame(k: number) {
    const line = this.tileFrame.children[0] as THREE.Line;
    const fill = this.tileFrame.children[2] as THREE.Mesh;
    (line.material as THREE.LineBasicMaterial).opacity = 0.35 + k * 0.55;
    (fill.material as THREE.MeshBasicMaterial).opacity = 0.06 + k * 0.11;
  }

  /**
   * The sun's shadow box is only 116 BU wide, which the spawn island fills: a region
   * two tiles out would fall outside it and lose its shadows (and a box that ends
   * mid-island cuts a hard straight edge across the ground). So the box walks with
   * the player, in whole-BU steps so the texels do not crawl while walking.
   */
  private followSun() {
    if (!this.sun) return;
    const x = Math.round(this.player.pos.x);
    const z = Math.round(this.player.pos.z);
    if (x === this.sunAt.x && z === this.sunAt.z) return;
    this.sunAt = { x, z };
    const t = this.sun.target;
    t.position.set(x, 0, z);
    this.sun.position.set(x + SUN_DIR.x * 60, SUN_DIR.y * 70, z + SUN_DIR.z * 60);
    t.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  /** Projects the stamina ribbon just above the slime's crown. */
  private updateStaminaHud() {
    const v = new THREE.Vector3(this.player.pos.x, this.player.pos.y + 1.5, this.player.pos.z);
    v.project(this.camera);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.staminaHud.x = (v.x * 0.5 + 0.5) * size.x;
    this.staminaHud.y = (-v.y * 0.5 + 0.5) * size.y;
    this.staminaHud.visible = v.z < 1 && this.player.stamina < 0.995;
  }

  /**
   * Where the "opening" card hangs: above the middle of the tile being opened, in
   * screen space. The card is anchored to that point every frame, so it reads as
   * belonging to the square the mist is giving up rather than to the HUD. It is
   * clamped into the frame, because the tile's centre can sit off-screen when the
   * camera is close to the frontier.
   */
  private updateGenHud() {
    if (!this.gen.active || !this.gen.tile) {
      this.genHud.visible = false;
      return;
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    const v = new THREE.Vector3(this.gen.tile.x * TILE, 3.4, this.gen.tile.z * TILE).project(this.camera);
    const margin = 150;
    this.genHud.x = Math.max(margin, Math.min(size.x - margin, (v.x * 0.5 + 0.5) * size.x));
    this.genHud.y = Math.max(96, Math.min(size.y - 120, (-v.y * 0.5 + 0.5) * size.y));
    this.genHud.visible = v.z < 1;
  }

  /**
   * Keep the character visible. Every tree/boulder registers a cheap cylinder;
   * we sample the focus→desired-eye segment and clamp the eye to the first
   * intersection. Cheap and reliable — raycasting merged InstancedMeshes
   * silently missed trunks the camera sat inside.
   */
  private resolveCameraOcclusion(dt: number) {
    this.occlTimer -= dt;
    if (this.occlTimer > 0) return;
    this.occlTimer = 0.08;

    const focus = this.cam.focusPoint;
    const yaw = this.cam.yaw;
    const pitch = this.cam.pitch;
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();

    const maxDist = this.cam.targetDistance;
    const step = 0.34;
    let limit = Infinity;
    // When the camera is high above the props (steep pitch), trunks and boulders
    // are below the sight line and clamping is pointless. Only test near-horizontal sight lines.
    const steep = pitch > 0.55;
    if (!steep) {
      for (let d = 1.0; d <= maxDist; d += step) {
        const px = focus.x + dir.x * d;
        const py = focus.y + dir.y * d;
        const pz = focus.z + dir.z * d;
        for (let i = 0; i < this.blockers.length; i++) {
          const b = this.blockers[i];
          if (py > b.top) continue;
          const dx = px - b.x;
          const dz = pz - b.z;
          if (dx * dx + dz * dz < b.r * b.r) {
            limit = Math.max(2.6, d - 0.45);
            break;
          }
        }
        if (limit < Infinity) break;
      }
    }

    if (limit < Infinity) this.cam.pushIn(limit);
    else this.cam.releasePush();
  }

  setFrozen(v: boolean) {
    this.frozen = v;
  }

  // --------------------------------------------------------------------------- settings

  /** Public settings surface — the React shell never reaches into engine internals. */
  applySettings(s: {
    renderPrecision: number;
    resolution: number;
    fpsCap: number;
    shadows: boolean;
    vegetationDensity: 'full' | 'sparse';
    fogDistance: number;
    lookSensitivity: number;
    invertY: boolean;
    cameraDistance: number;
    movementAssist: boolean;
    coneDeg?: number;
  }) {
    const prevDistance = this.settings.cameraDistance;
    this.settings = { ...this.settings, ...s };
    this.fpsCap = this.settings.fpsCap;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    // render precision = device pixel ratio cap; resolution = internal buffer scale
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.settings.renderPrecision));
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.round(w * this.settings.resolution), Math.round(h * this.settings.resolution), false);
    this.propRenderer.farRadius = Math.min(70, this.settings.fogDistance + 4);
    this.water?.setReach(this.settings.fogDistance);
    this.propRenderer.setFarVisible(this.settings.vegetationDensity !== 'sparse');
    if (this.cam) this.applyCameraSettings(prevDistance);
  }

  private applyCameraSettings(prevDistance = -1) {
    this.cam.sensitivity = this.settings.lookSensitivity;
    this.cam.invertY = this.settings.invertY;
    this.cam.movementAssist = this.settings.movementAssist;
    if (this.settings.cameraDistance !== prevDistance) {
      this.cam.setBaseDistance(this.settings.cameraDistance);
      this.cam.applyBaseDistance();
    }
  }

  /**
   * Throw the whole world away and build a brand new one from a fresh seed.
   * Used by the settings "重置世界" action.
   */
  resetWorld(seed: number = (Math.random() * 0x7fffffff) | 0): number {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage unavailable */
    }
    this.world = worldWithSeed(seed);
    this.buildFarIsletsGroup();
    this.field = new IslandField(this.world, true);
    // the old world's map memory does not carry over into the new one
    this.exploredCanvas = null;
    this.exploredCtx = null;
    // the stages run without a pause between them, so the new world is whole by the next frame
    void this.buildWorld();
    return this.world.seed;
  }

  /** The far floating islets are the one piece of scenery that depends on the seed. */
  private buildFarIsletsGroup() {
    const old = this.worldRoot.getObjectByName('Far_Islets');
    if (old) {
      this.worldRoot.remove(old);
      disposeTree(old);
    }
    this.worldRoot.add(buildFarIslets(this.world.seed));
  }

  /** The field is created by init(); resetWorld() replaces it. */
  private ensureField() {
    if (!this.field) {
      const saved = this.loadSaved();
      this.field = new IslandField(this.world, false);
      if (!this.field.load(saved)) this.field = new IslandField(this.world, true);
    }
  }

  // --------------------------------------------------------------------------- generation

  /** True when E is a legal action right now: at a frontier border, aimed at it, with nothing running. */
  get canWish() {
    return !this.gen.active && this.frontier.target !== null;
  }

  get generating() {
    return this.gen.active;
  }

  get regionCount() {
    return this.field.tiles.size;
  }

  /** World direction the camera is looking, for placing a wished region ahead. */
  get facing() {
    return { x: -Math.sin(this.cam.yaw), z: -Math.cos(this.cam.yaw) };
  }

  /** Frontier tiles for the maps (ungenerated, each next to known land). */
  frontierTiles(): { x: number; z: number; rel: string; open: boolean }[] {
    return this.field.frontier().map((f) => ({
      x: f.x,
      z: f.z,
      rel: compassName(f.x * TILE - this.player.pos.x, f.z * TILE - this.player.pos.z),
      open: f === this.frontier.target,
    }));
  }

  private setGen(stage: string, detail: string, progress: number) {
    this.gen.stage = stage;
    this.gen.detail = detail;
    this.gen.progress = Math.max(this.gen.progress, Math.min(1, progress));
    this.cbs.onGenerate?.({ ...this.gen });
  }

  cancelGenerate() {
    if (!this.gen.active) return;
    this.genCancel = true;
    // the server must stop as well: the AI call ends and a running Blender is closed
    const id = this.genJob;
    if (id) aiApi.cancel(id).catch(() => {
      /* it may simply have finished in the meantime */
    });
    this.setGen(this.gen.stage, '正在取消…', this.gen.progress);
  }

  /** Everything the AI should know about the place it is asked to continue. */
  private buildPayload(wish: string, target: FrontierTile): RegionPayload {
    const seen = new Map<string, number>();
    const neighbours = target.touches.map((nb) => {
      const tile = this.field.get(nb.x, nb.z);
      if (!tile) return null;
      const models: string[] = [];
      for (const p of this.props.byTile.get(tile.key) ?? []) if (!models.includes(p.model) && models.length < 9) models.push(p.model);
      return {
        x: tile.x,
        z: tile.z,
        rel: compassName(nb.x - target.x, nb.z - target.z),
        biome: tile.biome,
        name: tile.name,
        source: tile.spec.source ?? 'preset',
        // what the ground there is like, so the new tile can continue it
        peak: tile.peak,
        land: tile.land,
        feature: tile.feature?.type ?? 'none',
        models,
      };
    });
    // diagonal neighbours matter for continuity too
    for (const [dx, dz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const tile = this.field.get(target.x + dx, target.z + dz);
      if (tile && !neighbours.some((n) => n && n.x === tile.x && n.z === tile.z)) {
        neighbours.push({
          x: tile.x,
          z: tile.z,
          rel: compassName(dx, dz),
          biome: tile.biome,
          name: tile.name,
          source: tile.spec.source ?? 'preset',
          peak: tile.peak,
          land: tile.land,
          feature: tile.feature?.type ?? 'none',
          models: [],
        });
      }
    }
    const scratch: PropInstance[] = [];
    for (const p of this.props.near(this.frontier.ax, this.frontier.az, 48, scratch)) seen.set(p.model, (seen.get(p.model) ?? 0) + 1);
    // what the mist hides here is already decided by the land and the climate
    const tx = target.x * TILE;
    const tz = target.z * TILE;
    const o = this.field.outlook(tx, tz);
    const climate = { temp: Math.round(o.temp * 100) / 100, moist: Math.round(o.moist * 100) / 100, biome: o.biome, land: o.land, peak: Math.round(o.peak * 10) / 10 };
    const nearbyModels = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([id]) => id);
    return {
      wish,
      seed: this.world.seed,
      tile: { x: target.x, z: target.z },
      climate,
      context: {
        neighbours: neighbours.filter((n): n is NonNullable<typeof n> => !!n),
        nearbyModels,
        player: { x: Math.round(this.player.pos.x * 10) / 10, z: Math.round(this.player.pos.z * 10) / 10 },
      },
    };
  }

  /**
   * Opens the targeted tile: ask the server (AI, or the local recipe when no AI
   * is configured) for a region card, load anything Blender built for it, then
   * raise the land, move the mist and plant the flora. Resolves false when the
   * player cancelled or it failed (gen.error holds the reason).
   */
  async generate(wish: string): Promise<boolean> {
    const target = this.frontier.target;
    if (this.gen.active || !target) return false;
    this.genCancel = false;
    this.genAnchor = { x: this.frontier.ax, z: this.frontier.az };
    const tile = { x: target.x, z: target.z };
    this.gen = { active: true, stage: 'request', detail: '正在把愿望交给迷雾…', progress: 0.03, tile, cancelled: false, error: null, lastResult: null };
    this.cbs.onGenerate?.({ ...this.gen });
    this.frameTile(tile, true);
    // the swirl sits over the tile being opened, not on the spot the player stands at
    this.forming = buildFormingMist(target.x * TILE, target.z * TILE);
    this.addPart(this.forming);

    try {
      const jobId = (await aiApi.startRegion(this.buildPayload(wish, target))).job.id;
      this.genJob = jobId;
      let result: RegionResult | null = null;
      for (;;) {
        if (this.genCancel) throw new Error('__cancelled__');
        const j = await aiApi.job(jobId);
        if (j.status === 'failed') throw new Error(j.error || '生成失败');
        if (j.status === 'cancelled') throw new Error('__cancelled__');
        if (j.status === 'done' && j.result) {
          result = j.result;
          break;
        }
        if (!this.genCancel) this.setGen(j.stage, j.detail, j.progress);
        await sleep(420);
      }
      // the card's props are what it adds to the climate's own vegetation, not a list that replaces it
      const { props, ...rest } = result.spec;
      const spec: TileSpec = { ...rest, extra: props && props.length ? props : undefined };
      // kept with the tile, so the save can fetch them again after a reload
      spec.built = result.models;
      this.setGen('models', result.summary.blenderUsed ? `载入 Blender 新建的 ${result.models.length} 个模型…` : '新区域的资源已就绪', 0.9);
      for (const m of result.models) await this.library.loadGenerated(m, m.url);
      this.setGen('terrain', '新的地面正从雾里升起…', 0.95);
      await sleep(60);
      this.applyTile(spec);
      // The country the card describes may be larger than one tile: the same card
      // is laid on the tiles around it, nearest first, so a ridge or a ring of reef
      // is not cut off by the tile the player happened to aim at.
      const extent = Math.max(1, Math.min(3, Math.round(spec.extent ?? 1)));
      if (extent > 1 && this.spreadTile(spec, extent)) {
        this.setGen('terrain', `这片地比一格大，正在把它接成 ${extent} 格…`, 0.97);
        await sleep(260);
        const tile = this.field.get(spec.x, spec.z);
        if (tile) {
          this.refreshAfterTiles();
          const extra = this.plantTile(tile, [{ x: this.player.pos.x, z: this.player.pos.z, r: 9 }]);
          for (const p of extra) {
            p.hold = 0.4 + Math.hypot(p.x - this.genAnchor.x, p.z - this.genAnchor.z) * 0.04;
            p.fade = 0;
          }
          this.propRenderer.sync(this.props);
          this.refreshBlockers();
          this.propRenderer.update(this.player.pos.x, this.player.pos.z, true);
        }
      }
      this.setGen('reveal', `「${result.summary.name ?? spec.name ?? ''}」浮现了`, 1);
      this.gen.lastResult = {
        name: result.summary.name ?? spec.name ?? '',
        sourceLabel: result.summary.sourceLabel,
        blenderUsed: result.summary.blenderUsed,
        models: result.summary.blenderUsed ? result.models.length : 0,
      };
      this.gen.active = false;
      this.cbs.onGenerate?.({ ...this.gen });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.gen.cancelled = msg === '__cancelled__';
      this.gen.error = this.gen.cancelled ? null : msg;
      this.gen.active = false;
      this.gen.stage = this.gen.cancelled ? 'idle' : 'failed';
      this.gen.detail = this.gen.cancelled ? '已取消' : `失败：${this.gen.error}`;
      this.cbs.onGenerate?.({ ...this.gen });
      return false;
    } finally {
      this.genJob = null;
      if (this.forming) {
        this.removePart(this.forming);
        this.forming = null;
      }
    }
  }

  /**
   * Lays the rest of a country the card says it needs: the tiles around the aimed
   * one, nearest first, up to (extent − 1) extra tiles, each one registered with the
   * card's biome, relief and additions — but never a name, which belongs to the
   * whole country and is already on its first tile. Tiles the card would have to
   * push the sea into are skipped: a ridge stops at the coast.
   */
  private spreadTile(spec: TileSpec, extent: number): number {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ];
    let made = 0;
    const want = extent - 1;
    for (const [dx, dz] of dirs) {
      if (made >= want) break;
      const x = spec.x + dx;
      const z = spec.z + dz;
      if (this.field.get(x, z)) continue;
      // the card's climate, but no second name and no second landmark
      const copy: TileSpec = {
        ...spec,
        x,
        z,
        name: undefined,
        feature: undefined,
        source: spec.source,
        props: undefined,
        extra: spec.extra?.filter((r) => !r.landmark),
      };
      this.field.addTile(copy, false);
      made++;
      if (this.exploredCtx) revealTile(this.field, { x, z }, this.exploredCtx, this.exploredSpan, this.exploredCanvas!.width);
    }
    if (made) {
      this.field.touch();
      this.fogStamp++;
    }
    return made;
  }

  /**
   * Some chunks end up with a mesh that does not match the height field any more (an
   * export that was replaced, a chunk built before its neighbour raised the ground).
   * The result is a seam: a straight wall of triangles across the sand. Walk the chunks
   * around the new land and rebuild every one whose surface is more than a hand's width
   * away from the ground the game actually walks on.
   */
  private healTerrain(): number {
    let healed = 0;
    const pos = new THREE.Vector3();
    // the whole built set: a chunk can be left behind by a tile that arrived through a
    // causeway or an extent copy, and the mesh is the only thing that shows it
    for (const mesh of [...this.chunks.group.children] as THREE.Mesh[]) {
      const m = /^Chunk_(-?\d+)_(-?\d+)$/.exec(mesh.name);
      if (!m) continue;
      const i = +m[1];
      const j = +m[2];
      const arr = mesh.geometry.getAttribute('position').array as Float32Array;
      let worst = 0;
      // every third vertex is enough to catch a seam, and keeps the pass cheap
      for (let k = 0; k < arr.length; k += 9) {
        pos.set(arr[k], arr[k + 1], arr[k + 2]);
        const d = Math.abs(pos.y - this.field.height(pos.x, pos.z));
        if (d > worst) {
          worst = d;
          if (worst > 0.5) break;
        }
      }
      if (worst > 0.5) {
        this.field.clearHeights(i, j);
        this.chunks.buildChunk(i, j, true);
        healed++;
      }
    }
    if (healed) console.info(`[terrain] rebuilt ${healed} chunk(s) whose ground had moved under them`);
    return healed;
  }

  /** Rebuilds the ground, shore, mist, water and map after several tiles arrived at once. */
  private refreshAfterTiles() {
    connectTiles(this.field, this.spawn.x, this.spawn.z);
    const r = chunkRange(this.field.list(), 1);
    const fresh = this.chunks.buildRange(this.field, r);
    const rebuilt: THREE.Mesh[] = [];
    for (let j = r.z0; j <= r.z1; j++) {
      for (let i = r.x0; i <= r.x1; i++) {
        if (!this.chunks.has(i, j)) continue;
        this.field.clearHeights(i, j);
        this.chunks.buildChunk(i, j, true);
        const m = this.chunks.group.children.find((c) => c.name === `Chunk_${i}_${j}`) as THREE.Mesh | undefined;
        if (m) rebuilt.push(m);
      }
    }
    this.healTerrain();
    this.rebuildShore();
    this.rebuildMist(false);
    this.refreshLava();
    const b = tileBounds(this.field.list(), 6);
    this.water?.refresh(b.minX, b.minZ, b.maxX, b.maxZ);
    let extent = WORLD_SPAN / 2;
    for (const t of this.field.list()) extent = Math.max(extent, Math.hypot(t.x, t.z) * TILE + TILE * 0.9);
    this.mapBake = null;
    this.minimapSpan = extent * 2;
    this.minimap = renderMinimapCanvas(this.field, 1024, this.minimapSpan);
    this.initExploredMask();
    this.cbs.onMinimapReady?.(this.minimap);
    this.cbs.onRegionCount?.(this.regionCount);
    this.saveWorld();
    // the extra tiles rise white out of the mist, the way the aimed one did
    for (const mesh of [...fresh, ...rebuilt]) {
      const [ci, cj] = mesh.name.replace('Chunk_', '').split('_').map(Number);
      const x = (ci + 0.5) * CHUNK;
      const z = (cj + 0.5) * CHUNK;
      const near = this.field.list().some((t) => Math.abs(x - t.x * TILE) <= TILE / 2 + 9 && Math.abs(z - t.z * TILE) <= TILE / 2 + 9);
      if (!near) continue;
      const mat = terrainMaterial();
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = 0.72;
      mesh.material = mat;
      this.reveals.push({ mat, t: 0, dur: 2.1, mesh });
    }
  }

  /** Registers the tile in the field and rebuilds everything it touches. */
  private applyTile(spec: TileSpec) {
    this.field.addTile(spec);
    connectTiles(this.field, this.spawn.x, this.spawn.z);
    // a causeway re-registers the tile it lands on: work on the one in the field,
    // or no ground would count as this tile's and nothing would be planted
    const tile = this.field.get(spec.x, spec.z) ?? this.field.addTile(spec);
    const cx = tile.x * (TILE / CHUNK);
    const cz = tile.z * (TILE / CHUNK);
    const r = { x0: cx - 2 - BLEND_CHUNKS, x1: cx + 1 + BLEND_CHUNKS, z0: cz - 2 - BLEND_CHUNKS, z1: cz + 1 + BLEND_CHUNKS };
    const fresh = this.chunks.buildRange(this.field, r);
    const rebuilt: THREE.Mesh[] = [];
    for (let j = r.z0; j <= r.z1; j++) {
      for (let i = r.x0; i <= r.x1; i++) {
        if (this.chunks.has(i, j)) {
          // the new tile raises ground under chunks that already exist; the old
          // surface (and any exported heights for it) is now stale
          this.field.clearHeights(i, j);
          this.chunks.buildChunk(i, j, true);
          rebuilt.push(this.chunks.group.children.find((c) => c.name === `Chunk_${i}_${j}`) as THREE.Mesh);
        }
      }
    }
    this.healTerrain();
    this.rebuildShore();
    this.rebuildMist(false);
    this.refreshLava();
    // the floor moved under the new tile and the water above it has to know
    const m = 6;
    this.water?.refresh(spec.x * TILE - TILE / 2 - m, spec.z * TILE - TILE / 2 - m, spec.x * TILE + TILE / 2 + m, spec.z * TILE + TILE / 2 + m);

    // flora appears in a wave that runs from the shore the player stands on outward
    const placed = this.plantTile(tile, [{ x: this.player.pos.x, z: this.player.pos.z, r: 9 }]);
    for (const p of placed) {
      p.hold = 0.7 + Math.hypot(p.x - this.genAnchor.x, p.z - this.genAnchor.z) * 0.05 + (p.solid ? 0 : 0.25);
      p.fade = 0;
    }
    this.propRenderer.sync(this.props);
    this.refreshBlockers();
    this.propRenderer.update(this.player.pos.x, this.player.pos.z, true);

    // only the ground that actually rose gets the veil: the blend reaches ~6 BU past
    // the tile, so chunks further out (which barely moved) keep their colour
    const veil = (mesh: THREE.Mesh) => {
      const [ci, cj] = mesh.name.replace('Chunk_', '').split('_').map(Number);
      return Math.abs((ci + 0.5) * CHUNK - tile.x * TILE) <= TILE / 2 + 9 && Math.abs((cj + 0.5) * CHUNK - tile.z * TILE) <= TILE / 2 + 9;
    };
    for (const mesh of [...fresh, ...rebuilt]) {
      if (!veil(mesh)) continue;
      const mat = terrainMaterial();
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = 0.72;
      mesh.material = mat;
      this.reveals.push({ mat, t: 0, dur: 2.1, mesh });
    }

    // the map grows with the world; the fog of war is carried over
    let extent = WORLD_SPAN / 2;
    for (const t of this.field.list()) extent = Math.max(extent, Math.hypot(t.x, t.z) * TILE + TILE * 0.9);
    this.mapBake = null;
    this.minimapSpan = extent * 2;
    this.minimap = renderMinimapCanvas(this.field, 1024, this.minimapSpan);
    this.initExploredMask();
    // the land rose out of the mist: the map sees it now, together with its shore
    if (this.exploredCtx) revealTile(this.field, tile, this.exploredCtx, this.exploredSpan, this.exploredCanvas!.width);
    this.fogStamp++;
    this.cbs.onMinimapReady?.(this.minimap);
    this.cbs.onRegionCount?.(this.regionCount);
    this.saveWorld();
  }

  // --------------------------------------------------------------------------- persistence

  private loadSaved(): SavedWorld | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? (JSON.parse(raw) as SavedWorld) : null;
    } catch {
      return null;
    }
  }

  private saveWorld() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.field.toJSON()));
    } catch {
      /* storage unavailable or full: the world simply will not survive a reload */
    }
  }

  // --------------------------------------------------------------------------- fog of war

  /** Fog mask for map widgets. The stored mask is a square and the map sheet is unbounded. */
  fogMask() {
    return { canvas: this.exploredCanvas, span: this.exploredSpan };
  }

  /** Revealed share of the walkable land, 0–1. Sampled on a 96² grid; throttled by the caller. */
  exploredRatio(): number {
    const c = this.exploredCanvas;
    if (!c) return 0;
    const n = 96;
    const probe = document.createElement('canvas');
    probe.width = n;
    probe.height = n;
    const pctx = probe.getContext('2d')!;
    pctx.drawImage(c, 0, 0, n, n);
    const data = pctx.getImageData(0, 0, n, n).data;
    let land = 0;
    let seen = 0;
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const x = ((px + 0.5) / n - 0.5) * this.exploredSpan;
        const z = ((py + 0.5) / n - 0.5) * this.exploredSpan;
        if (this.field.height(x, z) < 0.3) continue;
        land++;
        if (data[(py * n + px) * 4 + 3] < 90) seen++;
      }
    }
    return land === 0 ? 0 : Math.min(1, seen / land);
  }

  /**
   * Rectangle of the world (BU) the map can see so far: where the full map may be
   * panned and how far it may zoom out are measured from it.
   */
  exploredBounds(): { x0: number; z0: number; x1: number; z1: number } {
    const c = this.exploredCanvas;
    const none = { x0: 0, z0: 0, x1: 0, z1: 0 };
    if (!c) return none;
    const n = 128;
    if (!this.boundsProbe) this.boundsProbe = document.createElement('canvas');
    const probe = this.boundsProbe;
    probe.width = n;
    probe.height = n;
    const pctx = probe.getContext('2d')!;
    pctx.clearRect(0, 0, n, n);
    pctx.drawImage(c, 0, 0, n, n);
    const data = pctx.getImageData(0, 0, n, n).data;
    let tx0 = n;
    let tx1 = -1;
    let ty0 = n;
    let ty1 = -1;
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        if (data[(py * n + px) * 4 + 3] >= 110) continue; // mist still standing here
        if (px < tx0) tx0 = px;
        if (px > tx1) tx1 = px;
        if (py < ty0) ty0 = py;
        if (py > ty1) ty1 = py;
      }
    }
    if (tx1 < tx0) return none;
    const bu = this.exploredSpan / n;
    return { x0: (tx0 - n / 2) * bu, z0: (ty0 - n / 2) * bu, x1: (tx1 + 1 - n / 2) * bu, z1: (ty1 + 1 - n / 2) * bu };
  }

  /**
   * Fog-of-war mask: everything misted except what has been seen. The world that
   * is already open is seen whole — its ground and the water by its shore — and
   * walking or swimming clears the mist further, a ragged blot at a time.
   */
  private initExploredMask() {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const prev = this.exploredCanvas;
    const prevSpan = this.exploredSpan;
    this.exploredSpan = this.minimapSpan;
    // Solid: bakeFog lays the cloud on with 'source-atop', which keeps the
    // destination alpha, so the cloud is exactly as opaque as this mask. At 0.985
    // the sheet under it showed through by a hair — and where the fog mask meets
    // its own tiled copies that hair differed, and drew a faint line on the map.
    const FOG = 'rgb(226, 238, 247)';

    if (prev) {
      // world grew: the old mask is the source of truth inside its own span
      const w = (size * prevSpan) / this.exploredSpan;
      const off = (size - w) / 2;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(prev, off, off, w, w);
      if (off > 0) {
        ctx.fillStyle = FOG;
        ctx.fillRect(0, 0, size, off);
        ctx.fillRect(0, size - off, size, off);
        ctx.fillRect(0, off, off, size - off * 2);
        ctx.fillRect(size - off, off, off, size - off * 2);
      }
    } else {
      ctx.fillStyle = FOG;
      ctx.fillRect(0, 0, size, size);
      // every tile that is open has been seen: a saved world comes back on the map as it was left
      for (const t of this.field.list()) revealTile(this.field, t, ctx, this.exploredSpan, size);
    }
    this.exploredCanvas = canvas;
    this.exploredCtx = ctx;
    (canvas as HTMLCanvasElement & { worldSpan?: number }).worldSpan = this.exploredSpan;
    this.fogStamp++;
  }

  /**
   * Clears the mist in a blot around a point (where the slime is swimming, out on
   * water no opened shore reaches). The outline wavers like the edge of the opened
   * land, so the two never read as different kinds of hole in the cloud.
   */
  private stampExplored(x: number, z: number, r: number, ctx: CanvasRenderingContext2D, size: number) {
    const toPx = (v: number) => (v / this.exploredSpan + 0.5) * size;
    const cx = toPx(x);
    const cy = toPx(z);
    const rp = (r / this.exploredSpan) * size;
    // the blot's own shape, fixed for the spot it is stamped at
    const h = ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) * Math.PI * 2;
    const blot = (k: number, amp: number) => {
      ctx.beginPath();
      const N = 36;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const w = 1 + amp * (Math.sin(3 * a + h) * 0.45 + Math.sin(7 * a + h * 2.3) * 0.35 + Math.sin(13 * a + h * 0.7) * 0.2);
        const px = cx + Math.cos(a) * rp * k * w;
        const py = cy + Math.sin(a) * rp * k * w;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    blot(0.8, 0.12);
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    blot(1, 0.22);
    ctx.restore();
    this.fogStamp++;
  }

  // --------------------------------------------------------------------------- input & queries

  requestJump() {
    this.input.requestJump();
  }

  /** On-screen dive button (touch): held down = dive. */
  requestDive(v: boolean) {
    this.input.setTouchDive(v);
  }

  /** Stamina bar click: a short forward surge. */
  requestDash() {
    return this.player?.dash() ?? false;
  }

  requestSprint(v: boolean) {
    this.input.setTouchSprint(v);
  }

  requestInteract(v: boolean) {
    this.input.requestInteract(v);
  }

  get viewYaw() {
    return this.cam.yaw;
  }

  /** Swing the camera round behind the character (minimap eye button). */
  lookBehind() {
    this.cam.snap(this.player.pos);
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  get fieldRef() {
    this.ensureField();
    return this.field;
  }

  get stats() {
    return {
      fps: this.lastFps,
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      position: this.player ? this.player.pos.clone() : new THREE.Vector3(),
      state: this.player ? this.player.state : 'idle',
      chunks: this.chunks?.count ?? 0,
      props: this.props.all.length,
      imported: this.birthGeos.size,
    };
  }

  minimapCanvas() {
    return this.minimap;
  }

  /** World-space centre and extent of everything generated so far. */
  worldExtent() {
    let extent = WORLD_SPAN / 2;
    for (const t of this.field.list()) extent = Math.max(extent, Math.hypot(t.x, t.z) * TILE + TILE * 1.5 + 10);
    return { half: extent, regions: this.field.list(), coverage: this.minimapSpan };
  }

  dispose() {
    this.disposed = true;
    this.stopBootLoop();
    this.library.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
