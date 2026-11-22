import * as THREE from 'three';
import { IslandField, DEFAULT_WORLD, worldWithSeed, WorldSettings, scatter, ScatterPoint, biomeWeights, ISLAND_HALF } from './world';
import { buildTerrain, buildFoam, traceCoast, renderMinimapCanvas, TerrainChunks, buildRegionTerrain, buildMergedCliff, WORLD_SPAN } from './terrain';
import { buildSky, buildFarIslets, Sea, buildMistRing, updateMistRing } from './env';
import {
  buildTreeA,
  buildTreeB,
  buildTreeC,
  buildTreeASimple,
  buildTreeBSimple,
  buildTreeCSimple,
  buildRock,
  buildRockSimple,
  buildGrassTuft,
  buildFlower,
} from './flora';
import { PAL, SUN_DIR } from './palette';
import { Player } from './player';
import { ThirdPersonCamera } from './camera';
import { InputController } from './input';
import { mulberry32 } from '../lib/noise';

export type InteractionTarget = {
  id: string;
  kind: 'mist' | 'landmark';
  label: string;
  position: THREE.Vector3;
  distance: number;
};

export interface GameCallbacks {
  onRegion?: (name: string) => void;
  onMinimapReady?: (canvas: HTMLCanvasElement) => void;
  /** fires when a new region has been generated (count includes the birth island) */
  onRegionCount?: (n: number) => void;
  /** fires ~10x/s: position, camera yaw and locomotion state for HUD widgets */
  onTick?: (s: GameTick) => void;
}

export interface GameTick {
  x: number;
  z: number;
  yaw: number;
  cameraYaw: number;
  speed: number;
  state: string;
  rings: number;
  /** stamina 0–1 for the HUD bar */
  stamina: number;
}

const MIST_RADIUS = 41.5;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private input: InputController;
  private player: Player;
  private cam: ThirdPersonCamera;
  private field: IslandField;
  private sea!: Sea;
  private clock = new THREE.Clock();
  private raf = 0;
  private cbs: GameCallbacks;
  private frozen = false;
  private disposed = false;

  private chunks!: TerrainChunks;
  private cliffGroup = new THREE.Group();
  /** coastline foam ribbon, retraced with the cliff skirt */
  private foam: THREE.Mesh | null = null;
  /** the walkable-world mist frontier — rebuilt outward as regions are wished into being */
  private mistGroup: THREE.Group | null = null;
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
  private host: HTMLElement;
  /** everything that belongs to the island itself — cleared and rebuilt on reset */
  private worldRoot = new THREE.Group();
  private world: WorldSettings = DEFAULT_WORLD;
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
  };
  /** far-LOD vegetation, hidden in sparse mode */
  private farLodMeshes: THREE.InstancedMesh[] = [];
  private grassMeshes: THREE.InstancedMesh[] = [];
  /** materials condensing out of the mist when a region is wished into being */
  private fogReveals: { mat: THREE.MeshStandardMaterial; t: number; dur: number; from: THREE.Color; to: THREE.Color }[] = [];
  /**
   * Analytic occluders: every tree/rock keeps a cheap cylinder so the camera can
   * test the whole focus→eye segment without raycasting merged instanced geometry.
   */
  private blockers: { x: number; z: number; r: number; top: number }[] = [];
  private occlTimer = 0;
  fpsCap = 0;
  /** fog-of-war mask for the minimap: opaque mist, transparent where walked */
  exploredCanvas: HTMLCanvasElement | null = null;
  private exploredCtx: CanvasRenderingContext2D | null = null;
  private exploredSpan = WORLD_SPAN;
  private exploredTimer = 0;
  /** screen-space position of the world-anchored E prompt, updated every frame */
  mistPrompt = { x: 0, y: 0, visible: false, inRange: false, dist: 0, ax: 0, az: 0 };
  /** screen anchor for the world-attached stamina ribbon above the slime */
  staminaHud = { x: 0, y: 0, visible: false };
  /** instanced trees/rocks fade when they drift between the camera and the slime */
  private fadeMeshes: THREE.InstancedMesh[] = [];
  /** shared vegetation material for every instanced mesh */
  private vegMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0,
  });

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
    // heavy mist: the world dissolves into cloud at ~85 BU, so nothing ahead is
    // readable until you walk into it — the reference archipelago feel
    this.fog = new THREE.Fog(0xffffff, 24, this.settings.fogDistance);
    this.scene.fog = this.fog;
    // sky = the host's CSS gradient behind the transparent canvas (see .stage)

    this.scene.add(this.worldRoot);
    this.field = new IslandField(this.world);
    const coast = traceCoast(this.field, 320);

    this.buildLights();
    this.buildEnvironment(coast);
    this.buildVegetation();

    const spawn = new THREE.Vector3(0, 0, 12);
    this.player = new Player(this.field, spawn);
    this.player.group.position.y = this.field.height(spawn.x, spawn.z);
    this.player.colliders = this.blockers;
    this.scene.add(this.player.group);

    this.cam = new ThirdPersonCamera(this.field, this.camera);
    this.cam.snap(this.player.pos);

    // The mist wall was built during buildEnvironment, BEFORE the player
    // existed, so it could not widen the walkable boundary. The player stayed on
    // the default 47.5 radius while the island reaches past 53 BU, which also
    // made the E range test (boundary - radius) measure from the wrong edge.
    this.rebuildMistWall();

    // diagnostic framing only (used for art-review screenshots); never reachable from gameplay UI
    if (typeof location !== 'undefined') {
      const preset = new URLSearchParams(location.search).get('cam');
      if (preset === 'wide') this.cam.frame(Math.PI * 0.86, 0.34, 13.2);
      else if (preset === 'low') this.cam.frame(Math.PI, 0.06, 5.2);
      else if (preset === 'high') this.cam.frame(Math.PI * 0.94, 0.72, 11.5);
      else if (preset === 'sun') this.cam.frame(2.52, 0.3, 9);
    }

    this.minimap = renderMinimapCanvas(this.field, 512, this.minimapSpan);
    this.initExploredMask();
    this.cbs.onMinimapReady?.(this.minimap);
    this.currentRegion = this.field.regionName(spawn.x, spawn.z);
    this.cbs.onRegion?.(this.currentRegion);

  }

  private buildLights() {
    // Bright midday key with cool sky fill — the reference art is high-key, with
    // crisp short contact shadows rather than a moody teal wash.
    const sun = new THREE.DirectionalLight(0xfff6e0, 2.15);
    sun.position.set(SUN_DIR.x * 60, SUN_DIR.y * 70, SUN_DIR.z * 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    const s = 58;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.09;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // sky/ground hemisphere: blue above, warm bounce from below
    const hemi = new THREE.HemisphereLight(0xcfeaff, 0x6f8a5c, 0.85);
    this.scene.add(hemi);

    // cool fill from the shadow side so nothing goes muddy
    const fill = new THREE.DirectionalLight(0xb8dcf5, 0.38);
    fill.position.set(-30, 22, -40);
    this.scene.add(fill);

    // warm rim to lift the silhouette
    const rim = new THREE.DirectionalLight(0xfff0cf, 0.42);
    rim.position.set(24, 30, -55);
    this.scene.add(rim);
  }

  private buildEnvironment(coast: THREE.Vector2[]) {
    this.worldRoot.add(buildSky());

    this.worldRoot.add(buildFarIslets(this.world.seed));

    const terrain = buildTerrain(this.field, this.world.seed, coast);
    this.chunks = terrain.chunks;
    this.worldRoot.add(this.chunks.group);
    this.worldRoot.add(this.cliffGroup);

    this.sea = new Sea();
    this.worldRoot.add(this.sea.mesh);
    this.worldRoot.add(this.sea.foamMesh);

    // cliff skirt + foam ring for the whole landmass; both are retraced whenever
    // the world grows (see rebuildShore)
    this.rebuildShore();

    // far mist strata beyond the island
    this.rebuildMistWall();

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

  private buildVegetation() {
    const seed = this.world.seed;
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.88,
      metalness: 0,
    });

    // keep the spawn clearing + opening camera line free of trunks and boulders
    const SPAWN = new THREE.Vector2(0, 12);
    const CAM_START = new THREE.Vector2(0, 19.5);
    // keep scatter clear of the spawn clearing AND of every registered prop
    // collider — grass blades stabbing through trunks and boulders read as
    // broken intersecting models, not lush ground cover
    const clearOf = (p: ScatterPoint, r: number) => {
      if (Math.hypot(p.x - SPAWN.x, p.z - SPAWN.y) <= r) return false;
      for (const b of this.blockers) {
        if (Math.hypot(p.x - b.x, p.z - b.z) < b.r + 1.1) return false;
      }
      return true;
    };
    const clearCam = (p: ScatterPoint, r: number) => Math.hypot(p.x - CAM_START.x, p.z - CAM_START.y) > r;

    // --- trees: three families sorted by altitude band ---
    const treeApts = scatter(this.field, 46, seed + 21, {
      minH: 1.2, maxH: 7, maxSlope: 0.36, minSpacing: 3.4, scaleMin: 0.86, scaleMax: 1.16,
      biomeBias: (x, z, h) => {
        const w = biomeWeights(h);
        const n = Math.sin(x * 0.08) * Math.cos(z * 0.07);
        return 0.45 + w.lowland * 0.75 + n * 0.12;
      },
    }).filter((p) => clearOf(p, 4.2) && clearCam(p, 8));
    const treeBpts = scatter(this.field, 40, seed + 22, {
      minH: 4.0, maxH: 10.5, maxSlope: 0.38, minSpacing: 3.0, scaleMin: 0.82, scaleMax: 1.12,
      biomeBias: (x, z, h) => {
        const w = biomeWeights(h);
        return 0.32 + w.slope * 0.9 + Math.sin(x * 0.05 + z * 0.04) * 0.1;
      },
    }).filter((p) => clearOf(p, 4.2) && clearCam(p, 8));
    const treeCpts = scatter(this.field, 22, seed + 23, {
      minH: 5.6, maxH: 14.5, maxSlope: 0.44, minSpacing: 3.6, scaleMin: 0.8, scaleMax: 1.1,
      biomeBias: (_x, _z, h) => {
        const w = biomeWeights(h);
        return 0.2 + w.high * 1.0;
      },
    }).filter((p) => clearOf(p, 6) && clearCam(p, 10));

    /**
     * Instanced scatter with a distance split, so the near ring keeps full detail
     * while the far ring uses a simplified mesh. Without this the whole island
     * submitted near-L0 geometry and blew the triangle budget.
     */
    const addInstanced = (
      nearGeo: THREE.BufferGeometry,
      farGeo: THREE.BufferGeometry | null,
      pts: ScatterPoint[],
      castShadow = true,
      blockerRadius = 0,
      blockerHeight = 0,
      farCut = 26,
    ) => {
      if (!pts.length) return;
      const nearPts = farGeo ? pts.filter((p) => Math.hypot(p.x, p.z) < farCut) : pts;
      const farPts = farGeo ? pts.filter((p) => Math.hypot(p.x, p.z) >= farCut) : [];

      const makeInst = (geo: THREE.BufferGeometry, list: ScatterPoint[], shadow: boolean) => {
        if (!list.length) return null;
        const inst = new THREE.InstancedMesh(geo, mat, list.length);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        const p = new THREE.Vector3();
        for (let i = 0; i < list.length; i++) {
          const pt = list[i];
          // Trunk rooting depth follows the LOCAL SLOPE. On a grade the uphill
          // side of the root flare was buried and the downhill side hung in the
          // air — the "树干吐出来 / 穿模" report. Sinking by slope keeps the
          // whole flare under the surface at every angle, and a small tilt along
          // the normal plants it the way a real tree grows out of a hillside.
          let sink: number;
          const tilt = new THREE.Quaternion();
          if (blockerRadius > 0) {
            const slope = this.field.slope(pt.x, pt.z);
            sink = 0.34 + slope * 1.55;
            const nrm = this.field.normal(pt.x, pt.z);
            // lean about half-way toward the surface normal (not fully: a
            // fully normal-aligned tree on a steep bank reads as falling over)
            const tiltAxis = new THREE.Vector3(-nrm[2], 0, nrm[0]).normalize();
            const tiltAngle = Math.acos(THREE.MathUtils.clamp(nrm[1], -1, 1)) * 0.5;
            if (tiltAxis.lengthSq() > 0.5) tilt.setFromAxisAngle(tiltAxis, tiltAngle);
          } else {
            sink = 0.06;
          }
          p.set(pt.x, pt.y - sink * pt.scale, pt.z);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pt.rot);
          q.premultiply(tilt);
          s.set(pt.scale, pt.scale * (0.94 + (i % 5) * 0.03), pt.scale);
          m.compose(p, q, s);
          inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = shadow;
        inst.receiveShadow = true;
        inst.frustumCulled = true;
        this.worldRoot.add(inst);
        return inst;
      };

      const nearInst = makeInst(nearGeo, nearPts, castShadow);
      const farInst = farGeo ? makeInst(farGeo, farPts, false) : null;

      if (blockerRadius > 0) {
        // trees/rocks: each instance keeps its own transform + occlusion state,
        // so ONLY the trunks actually crossing the sight line fade out — fading
        // the whole family ghosted every tree of that kind at once.
        // Transparency is per INSTANCE, via an instanced float attribute the
        // material multiplies into alpha (there is no per-instance opacity in
        // three.js, and instanceColor can only tint, not erase).
        for (const inst of [nearInst, farInst]) {
          if (!inst) continue;
          const list = inst === nearInst ? nearPts : farPts;
          const fades = new Float32Array(list.length).fill(1);
          inst.geometry.setAttribute('aFade', new THREE.InstancedBufferAttribute(fades, 1));
          const m = mat.clone();
          m.transparent = true;
          m.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
            // alpha must be applied to `diffuseColor`, before the opaque/dither
            // chain resolves it: writing gl_FragColor after <dithering_fragment>
            // is a no-op on three r18x + WebGL2, which is why the fade silently
            // did nothing and trees stayed solid in front of the lens.
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>', '#include <common>\nvarying float vFade;')
              .replace(
                '#include <opaque_fragment>',
                'diffuseColor.a *= vFade;\n#include <opaque_fragment>',
              );
          };
          m.customProgramCacheKey = () => 'veg-fade';
          inst.material = m;
          inst.userData.fades = fades;
          inst.userData.occluders = list.map((q, i) => {
            const matrix = new THREE.Matrix4();
            inst.getMatrixAt(i, matrix);
            return {
              matrix,
              x: q.x,
              z: q.z,
              // trunk radius for collision, but the CROWN is what actually
              // blocks the camera: a 4-5 BU canopy on a 0.55 BU trunk was
              // invisible to this test, so foliage hanging over the slime
              // never faded
              r: blockerRadius * q.scale,
              crownR: (blockerRadius + 1.15) * q.scale,
              top: q.y + blockerHeight * q.scale,
              fade: 1,
            };
          });
          this.fadeMeshes.push(inst as THREE.InstancedMesh);
        }
        for (const pt of pts) {
          this.blockers.push({
            x: pt.x,
            z: pt.z,
            r: blockerRadius * pt.scale,
            top: pt.y + blockerHeight * pt.scale,
          });
        }
      }
    };

    // 3 structural variants per family; distant copies swap to a simple silhouette
    for (let v = 0; v < 3; v++) {
      addInstanced(
        buildTreeA(seed + v * 31),
        buildTreeASimple(seed + v * 31),
        treeApts.filter((p) => p.variant === v),
        true,
        0.55,
        4.4,
      );
      addInstanced(
        buildTreeB(seed + 100 + v * 37),
        buildTreeBSimple(seed + 100 + v * 37),
        treeBpts.filter((p) => p.variant === v),
        true,
        0.5,
        5.2,
      );
      addInstanced(
        buildTreeC(seed + 200, v),
        buildTreeCSimple(seed + 200, v),
        treeCpts.filter((p) => p.variant === v),
        true,
        0.5,
        3.6,
      );
    }

    // --- rocks ---
    const rockPts = scatter(this.field, 74, seed + 41, {
      minH: -1.2, maxH: 13, maxSlope: 0.95, minSpacing: 2.4, scaleMin: 0.7, scaleMax: 1.5, variants: 2,
    }).filter((p) => clearOf(p, 2.4) && clearCam(p, 4));
    for (let v = 0; v < 2; v++) {
      addInstanced(buildRock(seed + v * 17), buildRockSimple(seed + v * 17), rockPts.filter((p) => p.variant === v), true, 1.0, 1.2, 22);
    }

    // --- grass tufts: CLUSTERED patches, not an even sprinkle ---
    // Uniform scatter at 0.4 BU spacing reads as litter: isolated blades standing
    // alone on bare ground. Real meadow cover grows in drifts. Seeds are placed
    // in clumps and each clump carries 3–6 tufts packed together, so the ground
    // reads as patches of grass with clear ground between them.
    const grassSeeds = scatter(this.field, 620, seed + 51, {
      minH: 1.9, maxH: 12, maxSlope: 0.72, minSpacing: 5.2, scaleMin: 0.9, scaleMax: 1.25,
      // never on the beach: sand must stay sand
      biomeBias: (_x, _z, h) => (h < 2.2 ? 0.15 : 1),
    }).filter((p) => clearOf(p, 2.2));
    const grassPts: ScatterPoint[] = [];
    const grnd = mulberry32(seed + 5117);
    for (const s of grassSeeds) {
      const n = 3 + Math.floor(grnd() * 4);
      for (let k = 0; k < n; k++) {
        // a tight cluster: 0.35–1.0 BU from its seed, biased to the middle
        const a = grnd() * Math.PI * 2;
        const r = Math.pow(grnd(), 0.7) * 1.05;
        const x = s.x + Math.cos(a) * r;
        const z = s.z + Math.sin(a) * r;
        if (x * x + z * z > 48 * 48) continue;
        const h = this.field.height(x, z);
        if (h < 1.85 || h > 12) continue;
        if (this.field.slope(x, z) > 0.78) continue;
        grassPts.push({
          x,
          z,
          y: h,
          scale: s.scale * (0.82 + grnd() * 0.42),
          rot: grnd() * Math.PI * 2,
          variant: Math.floor(grnd() * 3),
        });
      }
    }
    for (let v = 0; v < 3; v++) {
      addInstanced(
        buildGrassTuft(seed + v * 13),
        buildGrassTuft(seed + v * 13, true),
        grassPts.filter((p) => p.variant === v),
        false,
        0,
        0,
        30,
      );
    }

    // --- flowers: in the meadow too, and clustered with the grass ---
    const flowerPts = scatter(this.field, 150, seed + 61, {
      minH: 2.2, maxH: 8.5, maxSlope: 0.45, minSpacing: 2.6, scaleMin: 0.75, scaleMax: 1.2, variants: 3,
    }).filter((p) => clearOf(p, 2.6));
    for (let v = 0; v < 3; v++) {
      addInstanced(buildFlower(seed + v * 19), null, flowerPts.filter((p) => p.variant === v), false);
    }

    // --- amber lantern fungi: small glows near rocks on high ground ---
    const fungusGeo = buildTreeC(seed + 777, 2);
    const fungusPts = scatter(this.field, 9, seed + 71, {
      minH: 10, maxH: 22, maxSlope: 0.7, minSpacing: 6, scaleMin: 0.22, scaleMax: 0.34,
    }).filter((p) => clearOf(p, 8));
    addInstanced(fungusGeo, null, fungusPts, false);
  }

  /** Per-asset instance counts, for the quality budget report. */
  assetReport() {
    return {
      submittedTriangles: this.renderer.info.render.triangles,
      drawCalls: this.renderer.info.render.calls,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  /** Called every frame by the React shell (dt already fps-capped). */
  update(dtRaw: number) {
    if (this.disposed) return;
    const dt = Math.min(0.05, dtRaw);
    const intent = this.input.poll();
    const t = this.clock.elapsedTime;

    // the mist frontier drifts: the particle band slowly circles the world
    if (this.mistGroup) {
      this.mistGroup.rotation.y += dt * 0.012;
      updateMistRing(this.mistGroup, t);
    }

    // "浓雾逐步散开": a newly wished island condenses out of the mist instead
    // of popping in. Each material lerps from mist-white to its own colour.
    if (this.fogReveals.length) {
      for (let i = this.fogReveals.length - 1; i >= 0; i--) {
        const r = this.fogReveals[i];
        r.t += dt;
        const k = Math.min(1, r.t / r.dur);
        // ease-out so the land appears quickly, then settles
        const e = 1 - Math.pow(1 - k, 3);
        r.mat.color.copy(r.from).lerp(r.to, e);
        if (k >= 1) {
          r.mat.color.copy(r.to);
          this.fogReveals.splice(i, 1);
        }
      }
    }

    if (!this.frozen) {
      this.cam.handleLook(intent.lookX, intent.lookY);
      this.cam.handleZoom(this.input.consumeWheel());
      this.player.update(dt, intent, this.cam.movementYaw, false);
    } else {
      this.player.update(dt, intent, this.cam.movementYaw, true);
    }

    // sprint feedback: widen the lens / pull back, so speed is visible. This
    // must be set BEFORE cam.update, or the camera always lags one frame.
    this.cam.sprintAmount = this.player.sprintAmount;
    this.cam.update(dt, this.player.pos);
    this.resolveCameraOcclusion(dt);
    this.sea.update(dt);

    // slow breathing of the mist strata
    for (let i = 0; i < this.fogLayers.length; i++) {
      const m = this.fogLayers[i];
      m.rotation.y = t * (0.006 + i * 0.003);
      m.position.y = 2 + i * 3 + Math.sin(t * 0.24 + i) * 0.3;
    }

    // fog of war: reveal around the player (throttled)
    this.exploredTimer -= dt;
    if (this.exploredCtx && this.exploredTimer <= 0) {
      this.exploredTimer = 0.4;
      this.stampExplored(this.player.pos.x, this.player.pos.z, 17, this.exploredCtx, this.exploredCanvas!.width);
    }

    // world-anchored E prompt: march ahead for the mist edge
    this.updateMistPrompt();
    this.updateStaminaHud();

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
        rings: 0,
        stamina: this.player.stamina,
      });
    }

    // occlusion softening: only the instances crossing the camera→slime sight
    // line fade to a whisper; everyone else in the family stays solid
    for (const m of this.fadeMeshes) {
      const occ = m.userData.occluders as
        | { x: number; z: number; r: number; crownR?: number; top: number; fade: number }[];
      const fades = m.userData.fades as Float32Array | undefined;
      if (!occ || !fades) continue;
      const c = this.camera.position;
      const p = this.player.pos;
      const ax = c.x, ay = c.y, az = c.z;
      const dx = p.x - ax, dy = p.y + 0.5 - ay, dz = p.z - az;
      const len2 = dx * dx + dz * dz || 1e-6;
      let dirty = false;
      for (let i = 0; i < occ.length; i++) {
        const q = occ[i];
        // nearest point on the sight line (horizontal projection) + a height test,
        // so a trunk passing BESIDE or OVER the slime does not fade
        const t = Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.z - az) * dz) / len2));
        const px = ax + dx * t;
        const pz = az + dz * t;
        const py = ay + dy * t;
        // test against the CROWN, not just the trunk, and allow the sight line
        // to pass near (not strictly through) it — a canopy grazing the frame
        // edge is still "something in front of the camera". The near bound is
        // deliberately tiny (0.02): a tree the camera is already pressed
        // against still sits right in front of the lens and must fade.
        const rr = (q.crownR ?? q.r) * 1.15;
        const blocked =
          (q.x - px) * (q.x - px) + (q.z - pz) * (q.z - pz) < rr * rr &&
          py < q.top &&
          py > q.top - 6.5 &&
          t > 0.02 &&
          t < 0.99;
        const next = THREE.MathUtils.lerp(q.fade, blocked ? 0.22 : 1, Math.min(1, dt * 9));
        if (Math.abs(next - q.fade) > 0.001) dirty = true;
        q.fade = next;
        fades[i] = next;
      }
      if (dirty) (m.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
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
   * Projects the mist frontier ahead of the player into screen space for the E
   * marker. The marker only exists when the player is actually standing at the
   * frontier: E anywhere else must do nothing at all.
   */
  private updateMistPrompt() {
    const px = this.player.pos.x;
    const pz = this.player.pos.z;
    const yaw = this.cam.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);

    // "At the frontier" is decided by the GROUND, not by a radius estimate:
    // march the sight line forward and find the shore. If the sea starts within
    // REACH BU ahead, the player is standing at the edge of the known world.
    const REACH = 13;
    let seaAhead = -1;
    for (let d = 2; d <= REACH + 10; d += 0.75) {
      if (this.field.height(px + fx * d, pz + fz * d) < 0.3) {
        seaAhead = d;
        break;
      }
    }
    if (seaAhead < 0 || seaAhead > REACH) {
      this.mistPrompt.visible = false;
      this.mistPrompt.inRange = false;
      return;
    }

    let found: { x: number; y: number; z: number; d: number } | null = null;
    {
      const d = seaAhead;
      const sx = px + fx * d;
      const sz = pz + fz * d;
      found = { x: sx, y: Math.max(this.field.height(sx, sz), 0) + 1.15, z: sz, d };
    }
    // in range but not aimed at the sea yet: no marker, and E stays inert
    this.mistPrompt.inRange = !!found;
    if (!found) {
      this.mistPrompt.visible = false;
      return;
    }
    const v = new THREE.Vector3(found.x, found.y, found.z).project(this.camera);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.mistPrompt.x = (v.x * 0.5 + 0.5) * size.x;
    this.mistPrompt.y = (-v.y * 0.5 + 0.5) * size.y;
    this.mistPrompt.visible = v.z < 1 && this.mistPrompt.x > -120 && this.mistPrompt.y > -120 && this.mistPrompt.x < this.host.clientWidth + 120 && this.mistPrompt.y < this.host.clientHeight + 120;
    this.mistPrompt.dist = found.d;
    this.mistPrompt.ax = found.x;
    this.mistPrompt.az = found.z;
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
   * Keep the character visible. Every tree/boulder registers a cheap cylinder;
   * we sample the focus→desired-eye segment and clamp the eye to the first
   * intersection. Cheap (a few hundred distance checks at 10 Hz) and reliable —
   * raycasting merged InstancedMeshes silently missed trunks the camera sat inside.
   */
  private resolveCameraOcclusion(dt: number) {
    this.occlTimer -= dt;
    if (this.occlTimer > 0) return;
    this.occlTimer = 0.08;

    const focus = this.cam.focusPoint;
    const yaw = this.cam.yaw;
    const pitch = this.cam.pitch;
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ).normalize();

    const maxDist = this.cam.targetDistance;
    const step = 0.34;
    let limit = Infinity;
    // When the camera is high above the props (steep pitch), trunks and boulders
    // are below the sight line and clamping is pointless — and it could trap the
    // eye inside the player's own space. Only test near-horizontal sight lines.
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
    this.fog.far = this.settings.fogDistance;
    const sparse = this.settings.vegetationDensity === 'sparse';
    for (const m of this.farLodMeshes) m.visible = !sparse;
    for (let i = 0; i < this.grassMeshes.length; i++) this.grassMeshes[i].visible = !(sparse && i % 2 === 1);

    // camera feel
    this.cam.sensitivity = this.settings.lookSensitivity;
    this.cam.invertY = this.settings.invertY;
    this.cam.movementAssist = this.settings.movementAssist;
    if (this.settings.cameraDistance !== prevDistance) {
      this.cam.setBaseDistance(this.settings.cameraDistance);
      this.cam.applyBaseDistance();
    }
  }

  /**
   * Throw the whole island away and build a brand new one from a fresh seed.
   * Used by the settings "重置世界" action. Everything that belongs to the world
   * lives under `worldRoot`, so the reset is one subtree swap; the camera, HUD
   * and renderer stay untouched.
   */
  resetWorld(seed: number = (Math.random() * 0x7fffffff) | 0): number {
    // clear the previous island
    this.scene.remove(this.worldRoot);
    this.worldRoot.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    this.worldRoot = new THREE.Group();
    this.scene.add(this.worldRoot);

    this.fogLayers = [];
    this.farLodMeshes = [];
    this.grassMeshes = [];
    this.fadeMeshes = [];
    this.blockers = [];
    this.cliffGroup = new THREE.Group();
    this.foam = null;

    this.world = worldWithSeed(seed);
    this.field = new IslandField(this.world);
    const coast = traceCoast(this.field, 320);
    this.buildEnvironment(coast);
    this.buildVegetation();
    this.player.colliders = this.blockers;

    // put the character back on the new island's spawn clearing; the old
    // character must leave the scene, or a second slime lingers on the new island
    this.scene.remove(this.player.group);
    const spawn = new THREE.Vector3(0, 0, 12);
    this.player = new Player(this.field, spawn);
    this.player.group.position.y = this.field.height(spawn.x, spawn.z);
    this.scene.add(this.player.group);
    // the opening pose faces the camera, same as a fresh boot
    this.player.yaw = Math.PI;
    this.player.targetYaw = Math.PI;
    this.cam = new ThirdPersonCamera(this.field, this.camera);
    this.cam.snap(this.player.pos);
    this.fog.far = this.settings.fogDistance;

    // fresh map + fog of war
    this.exploredCanvas = null;
    this.exploredSpan = WORLD_SPAN;
    this.minimapSpan = WORLD_SPAN;
    this.minimap = renderMinimapCanvas(this.field, 512, this.minimapSpan);
    this.initExploredMask();
    this.cbs.onMinimapReady?.(this.minimap);
    this.cbs.onRegionCount?.(1);
    this.currentRegion = this.field.regionName(spawn.x, spawn.z);
    this.cbs.onRegion?.(this.currentRegion);
    return this.world.seed;
  }

  /** Rebuilds the mist frontier so it encloses every known landmass. */
  private rebuildMistWall() {
    // Measure the ACTUAL coastline instead of deriving a radius from region
    // centres. A radius estimate either cut through the newest island (mist
    // wall standing in the middle of walkable ground) or fenced the player in
    // well short of the beach — the reported air wall.
    const N = 96;
    let landMax = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let last = 0;
      for (let r = 6; r <= 220; r += 2) {
        if (this.field.height(dx * r, dz * r) >= 0.3) last = r;
      }
      landMax = Math.max(landMax, last);
    }
    landMax = Math.max(landMax, MIST_RADIUS);
    if (this.player) this.player.boundaryRadius = landMax + 2.2;
    if (this.mistGroup) {
      this.worldRoot.remove(this.mistGroup);
      this.mistGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | undefined;
        mat?.dispose();
      });
    }
    this.mistGroup = buildMistRing(landMax + 7);
    this.mistGroup.position.y = 0;
    this.worldRoot.add(this.mistGroup);
  }

  /**
   * Generates a new island in the direction the player is FACING, sized large
   * enough to read as a real region, and merged into the current shore with a
   * wide filled land bridge. Returns the region label, or null when the wish
   * could not be placed (the caller then leaves the world untouched).
   */
  generateRegion(name: string, _random: boolean, facing?: { x: number; z: number }): string | null {
    const existing = this.field.regions;
    const nameSeed = name ? [...name].reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) >>> 0, 5381) : 0;
    // Large regions: the brief's islands are places you walk across for a while,
    // not bumps on the horizon.
    const radius = 46 + (nameSeed % 11);

    // ---- direction: straight ahead of the camera, nudged aside if another
    // region already sits there. The wish must land where the player is looking.
    const baseAngle = facing ? Math.atan2(facing.z, facing.x) : Math.atan2(this.player.pos.z, this.player.pos.x);
    let angle = baseAngle;
    for (let attempt = 0; attempt < 18; attempt++) {
      const a = baseAngle + (attempt === 0 ? 0 : (attempt % 2 === 1 ? 1 : -1) * Math.ceil(attempt / 2) * 0.32);
      let clear = true;
      for (const reg of existing) {
        const regA = Math.atan2(reg.z, reg.x);
        const da = Math.abs(Math.atan2(Math.sin(a - regA), Math.cos(a - regA)));
        if (da < 0.7) {
          clear = false;
          break;
        }
      }
      if (clear) {
        angle = a;
        break;
      }
      if (attempt === 17) angle = a;
    }

    // ---- anchor: walk the FACING ray outward from the PLAYER to the shoreline
    // of the known land, so the new island sits directly ahead of them.
    const fx = Math.cos(angle);
    const fz = Math.sin(angle);
    const pxs = this.player.pos.x;
    const pzs = this.player.pos.z;
    const isSea = (x: number, z: number) => this.field.height(x, z) < 0.5;

    let shoreAhead = 0;
    for (let r = 2; r <= 130; r += 1) {
      if (isSea(pxs + fx * r, pzs + fz * r)) {
        // step back to the last dry sample so the anchor is still on the beach
        shoreAhead = Math.max(2, r - 1.5);
        break;
      }
    }
    if (shoreAhead <= 0) {
      // facing inland: find the far shore along this bearing and express it as a
      // distance FROM THE PLAYER. (Adding the player's radius to a distance that
      // was already measured from the player counted it twice, which is what
      // parked the bridge anchor 21 BU out at sea and left the water gap.)
      for (let r = 2; r <= 150; r += 1) {
        if (isSea(fx * r, fz * r)) {
          const far = Math.hypot(fx * r - pxs, fz * r - pzs);
          shoreAhead = Math.max(4, far - 1.5);
          break;
        }
      }
      if (shoreAhead <= 0) shoreAhead = 26;
    }

    const ax = pxs + fx * shoreAhead;
    const az = pzs + fz * shoreAhead;
    const anchorH = Math.max(1.0, this.field.height(ax, az));

    // The dome centre sits well past the anchor: the raised part of a dome starts
    // around 0.8 r from its centre, so this keeps the new slope ~5 BU clear of
    // the player while still overlapping the old shore, with the causeway
    // filling the distance between them.
    const dist = shoreAhead + radius * 0.62;
    const rx = pxs + fx * dist;
    const rz = pzs + fz * dist;

    const region = {
      x: rx,
      z: rz,
      radius,
      height: 10.5 + (nameSeed % 5) + ((nameSeed >>> 3) % 100) / 22,
      phase: (nameSeed % 628) / 100,
      name: name || `区域 ${existing.length + 1}`,
      // a wide causeway: the strait is filled with continuous ground, not bridged
      // by a narrow isthmus, so there is no seam and no swim
      // wide enough that the strait is filled with ground, and starting from the
      // actual beach height so the causeway joins the shore flush
      neck: { ax, az, width: Math.max(34, radius * 0.86), height: Math.max(1.8, anchorH * 1.05) },
    };
    this.field.addRegion(region);

    // The wished land rises OUT of the dense fog. Rather than switching the
    // fog off in a single frame, each new material fades its fog density to
    // zero over ~1.2s: the island visibly condenses out of the mist, which is
    // the "浓雾逐步散开" step the brief asks for.
    const knownChunks = new Set(this.chunks.group.children);
    const knownWorld = new Set(this.worldRoot.children);
    const liftFog = (m: THREE.Mesh | THREE.InstancedMesh) => {
      const mat = (m.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
      mat.fog = false;
      m.material = mat;
      this.fogReveals.push({ mat, t: 0, dur: 1.2, from: new THREE.Color(0xffffff), to: mat.color.clone() });
      // start fully white so the land is hidden until the reveal plays
      mat.color.set(0xffffff);
    };

    // terrain chunks: built AND rebuilt, so ground raised under an existing
    // chunk stops showing the old surface through the new one
    buildRegionTerrain(this.field, this.world.seed, this.chunks, { x: rx, z: rz }, radius);

    // one skirt for the whole merged landmass — per-region skirts ran through
    // the island they merged into and read as interpenetrating rock
    this.rebuildShore();

    // vegetation for the new island
    this.buildRegionVegetation(region, nameSeed);

    for (const child of this.chunks.group.children) {
      if (!knownChunks.has(child)) liftFog(child as THREE.Mesh);
    }
    for (const child of this.worldRoot.children) {
      if (!knownWorld.has(child) && child instanceof THREE.InstancedMesh) liftFog(child);
    }

    // push the mist frontier out past the newest land
    this.rebuildMistWall();

    // refresh the map with the extended world
    let extent = WORLD_SPAN / 2;
    for (const reg of this.field.regions) {
      extent = Math.max(extent, Math.hypot(reg.x, reg.z) + reg.radius * 1.6 + 10);
    }
    this.minimapSpan = extent * 2;
    this.minimap = renderMinimapCanvas(this.field, 1024, this.minimapSpan);
    this.initExploredMask();
    // reveal the wished island in the fog at once — it was created by the wish,
    // so the player should see it bordering the known world immediately
    if (this.exploredCtx) {
      this.stampExplored(rx, rz, radius * 1.25, this.exploredCtx, this.exploredCanvas!.width);
      this.stampExplored(ax, az, radius * 0.7, this.exploredCtx, this.exploredCanvas!.width);
    }
    this.cbs.onMinimapReady?.(this.minimap);
    this.cbs.onRegionCount?.(this.field.regions.length + 1);
    return region.name;
  }

  /** Retraces the cliff skirt + foam ring of the merged landmass after the world grows. */
  private rebuildShore() {
    while (this.cliffGroup.children.length) {
      const old = this.cliffGroup.children.pop() as THREE.Mesh;
      old.geometry?.dispose();
      (old.material as THREE.Material | undefined)?.dispose();
    }
    let maxDist = MIST_RADIUS;
    for (const reg of this.field.regions) {
      maxDist = Math.max(maxDist, Math.hypot(reg.x, reg.z) + reg.radius * 1.5);
    }
    const cliff = buildMergedCliff(this.field, this.world.seed, maxDist + 10);
    cliff.name = 'Terrain_Cliff';
    this.cliffGroup.add(cliff);

    if (this.foam) {
      this.worldRoot.remove(this.foam);
      this.foam.geometry.dispose();
      (this.foam.material as THREE.Material).dispose();
    }
    const coast = traceCoast(this.field, 300, { x: 0, z: 0 }, maxDist + 10);
    this.foam = buildFoam(coast, this.world.seed);
    this.worldRoot.add(this.foam);
  }

  /** Fog-of-war mask: starts fully misted, holes punched where the player walks. */
  private initExploredMask() {
    // 1024² so the cloud stays crisp when the map zooms in: at 512 the mask was
    // ~1.4 BU/px and magnified 8× at max zoom, which read as a soft band
    // sliding over the terrain — the "迷雾和地图分层" report.
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const prev = this.exploredCanvas;
    const prevSpan = this.exploredSpan;
    this.exploredSpan = this.minimapSpan;
    // FOG base alpha must be ~0.99: Chromium's canvas 'source-atop' (used by
    // bakeFog to whiten the cloud) keeps the DESTINATION alpha, so the cloud
    // can never end up more opaque than this mask. At 0.84 the whole island
    // ghosted through the map fog; near-opaque here means near-opaque there.
    const FOG = 'rgba(214, 232, 244, 0.985)';

    if (prev) {
      // world grew: the old mask is the source of truth inside its own span, so
      // copy it verbatim and fog only the new ring outside it
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
      // only the spawn clearing starts revealed — the rest of the island waits
      // under the mist until the player actually walks there
      this.stampExplored(0, 8, 12, ctx, size);
      this.stampExplored(0, 0, 15, ctx, size);
    }
    this.exploredCanvas = canvas;
    this.exploredCtx = ctx;
    (canvas as HTMLCanvasElement & { worldSpan?: number }).worldSpan = this.exploredSpan;
  }

  /**
   * Fog mask for map widgets. The stored mask is a square and the map sheet is
   * unbounded, so widgets fill the rest of the sheet with the same cloud tile
   * (see bakeCloudTile) — the fog then covers the whole map with no seam and no
   * edge, instead of unexplored terrain showing past the mask ("迷雾图层没有覆盖地图").
   */
  fogMask() {
    return { canvas: this.exploredCanvas, span: this.exploredSpan };
  }

  /**
   * Revealed share of the walkable land, 0–1 — "已探索" should count the island,
   * not the empty sea around it. Sampled on a 96² grid; throttled by the caller.
   */
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

  private stampExplored(x: number, z: number, r: number, ctx: CanvasRenderingContext2D, size: number) {
    const toPx = (v: number) => ((v / this.exploredSpan) + 0.5) * size;
    const rPx = (r / this.exploredSpan) * size;
    const g = ctx.createRadialGradient(toPx(x), toPx(z), rPx * 0.72, toPx(x), toPx(z), rPx);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(toPx(x), toPx(z), rPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  get explored() {
    return this.exploredCanvas;
  }

  /** Vegetation scatter for one generated island. */
  private buildRegionVegetation(region: { x: number; z: number; radius: number; name: string }, seed: number) {
    const mat = this.vegMat;
    const centre = { x: region.x, z: region.z };
    // nothing may be planted on top of the character: a wish is cast while
    // standing on the shore, and trunks erupting around the slime both look
    // broken and trap it
    const px0 = this.player.pos.x;
    const pz0 = this.player.pos.z;
    const inRegion = (p: ScatterPoint) =>
      Math.hypot(p.x - region.x, p.z - region.z) < region.radius * 0.92 &&
      Math.hypot(p.x - px0, p.z - pz0) > 11;

    const add = (
      geo: THREE.BufferGeometry,
      pts: ScatterPoint[],
      castShadow: boolean,
      farGeo: THREE.BufferGeometry | null,
      farCut: number,
      /** >0 makes the family solid (collision + camera-occlusion fade), like the birth island */
      blockerRadius = 0,
      blockerHeight = 0,
    ) => {
      if (!pts.length) return;
      const near = farGeo ? pts.filter((p) => Math.hypot(p.x - region.x, p.z - region.z) < farCut) : pts;
      const far = farGeo ? pts.filter((p) => Math.hypot(p.x - region.x, p.z - region.z) >= farCut) : [];
      const make = (g: THREE.BufferGeometry, list: ScatterPoint[], shadow: boolean) => {
        if (!list.length) return null;
        const inst = new THREE.InstancedMesh(g, mat, list.length);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const sv = new THREE.Vector3();
        const pv = new THREE.Vector3();
        for (let i = 0; i < list.length; i++) {
          const pt = list[i];
          // solid props sink by slope and tilt with the ground, so the root flare
          // never floats on a grade (same planting rule as the birth island)
          let sink: number;
          const tilt = new THREE.Quaternion();
          if (blockerRadius > 0) {
            sink = 0.34 + this.field.slope(pt.x, pt.z) * 1.55;
            const nrm = this.field.normal(pt.x, pt.z);
            const tiltAxis = new THREE.Vector3(-nrm[2], 0, nrm[0]).normalize();
            const tiltAngle = Math.acos(THREE.MathUtils.clamp(nrm[1], -1, 1)) * 0.5;
            if (tiltAxis.lengthSq() > 0.5) tilt.setFromAxisAngle(tiltAxis, tiltAngle);
          } else {
            sink = 0.02;
          }
          pv.set(pt.x, pt.y - sink * pt.scale, pt.z);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pt.rot);
          q.premultiply(tilt);
          sv.set(pt.scale, pt.scale * (blockerRadius > 0 ? 0.94 + (i % 5) * 0.03 : 1), pt.scale);
          m.compose(pv, q, sv);
          inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = shadow;
        inst.receiveShadow = true;
        this.worldRoot.add(inst);
        return inst;
      };
      const inst = make(geo, near, castShadow);
      let fi: THREE.InstancedMesh | null = null;
      if (farGeo) {
        fi = make(farGeo, far, false);
        if (fi) this.farLodMeshes.push(fi);
      }
      // collision + occlusion fade for wished-island props: without this the
      // slime walks straight through every new tree (the reported 穿模)
      if (blockerRadius > 0) {
        for (const i of [inst, fi]) {
          if (!i) continue;
          const list = i === inst ? near : far;
          i.material = mat.clone();
          i.material.transparent = true;
          i.userData.points = list.map((p0) => ({ x: p0.x, z: p0.z }));
          i.userData.fade = 1;
          this.fadeMeshes.push(i);
        }
        for (const pt of pts) {
          this.blockers.push({
            x: pt.x,
            z: pt.z,
            r: blockerRadius * pt.scale,
            top: pt.y + blockerHeight * pt.scale,
          });
        }
      }
      return inst;
    };

    // Larger regions hold more trees, and nothing is planted on the sand or on
    // the steep inner rim of the dome.
    const treeA = scatter(this.field, Math.round(region.radius * 1.1), seed + 21, {
      minH: 2.4, maxH: 9, maxSlope: 0.34, minSpacing: 3.4, scaleMin: 0.86, scaleMax: 1.16,
      radius: region.radius, centre,
    }).filter(inRegion);
    const treeB = scatter(this.field, Math.round(region.radius * 0.9), seed + 22, {
      minH: 4.5, maxH: 15, maxSlope: 0.55, minSpacing: 3.0, scaleMin: 0.82, scaleMax: 1.12,
      radius: region.radius, centre,
    }).filter(inRegion);
    const treeC = scatter(this.field, Math.round(region.radius * 0.4), seed + 23, {
      minH: 7, maxH: 20, maxSlope: 0.6, minSpacing: 3.6, scaleMin: 0.8, scaleMax: 1.1,
      radius: region.radius, centre,
    }).filter(inRegion);

    for (let v = 0; v < 3; v++) {
      add(buildTreeA(seed + v * 31), treeA.filter((p) => p.variant === v), true, buildTreeASimple(seed + v * 31), 22, 0.55, 4.4);
      add(buildTreeB(seed + 100 + v * 37), treeB.filter((p) => p.variant === v), true, buildTreeBSimple(seed + 100 + v * 37), 22, 0.5, 5.2);
      add(buildTreeC(seed + 200, v), treeC.filter((p) => p.variant === v), true, buildTreeCSimple(seed + 200, v), 22, 0.5, 3.6);
    }

    const grassPts = scatter(this.field, 260, seed + 51, {
      minH: 2.4, maxH: 17, maxSlope: 0.72, minSpacing: 4.6, scaleMin: 0.85, scaleMax: 1.25,
      radius: region.radius, centre,
      biomeBias: (_x, _z, h) => (h < 2.8 ? 0.12 : 1),
    }).filter(inRegion);
    for (let v = 0; v < 3; v++) {
      const inst = add(
        buildGrassTuft(seed + v * 13),
        grassPts.filter((p) => p.variant === v),
        false,
        buildGrassTuft(seed + v * 13, true),
        30,
      );
      if (inst) this.grassMeshes.push(inst);
    }

    const flowerPts = scatter(this.field, 120, seed + 61, {
      minH: 1.6, maxH: 12, maxSlope: 0.5, minSpacing: 1.3, scaleMin: 0.75, scaleMax: 1.3,
      radius: region.radius, centre,
    }).filter(inRegion);
    for (let v = 0; v < 3; v++) {
      add(buildFlower(seed + v * 19), flowerPts.filter((p) => p.variant === v), false, null, 0);
    }
  }

  /** Jump / interact requests from touch buttons. */
  requestJump() {
    this.input.requestJump();
  }

  /** Stamina bar click: a short forward surge. */
  requestDash() {
    return this.player.dash();
  }

  /** True when E is a legal action right now (player is at the mist frontier). */
  get canWish() {
    return this.mistPrompt.inRange && this.mistPrompt.visible;
  }

  /** World direction the camera is looking, for placing a wished region ahead. */
  get facing() {
    return { x: -Math.sin(this.cam.yaw), z: -Math.cos(this.cam.yaw) };
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

  get chargedRingCount() {
    return 0;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  get fieldRef() {
    return this.field;
  }

  get stats() {
    return {
      fps: this.lastFps,
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      position: this.player.pos.clone(),
      state: this.player.state,
    };
  }

  minimapCanvas() {
    return this.minimap;
  }

  /** World-space centre and extent of everything generated so far. */
  worldExtent() {
    let extent = WORLD_SPAN / 2;
    for (const reg of this.field.regions) {
      extent = Math.max(extent, Math.hypot(reg.x, reg.z) + reg.radius * 1.5 + 10);
    }
    return { half: extent, regions: this.field.regions, coverage: this.minimapSpan };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { ISLAND_HALF, MIST_RADIUS };
void 0;
