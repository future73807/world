import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The model library: Blender-exported prefabs plus any model an AI had Blender
 * build at runtime. Everything is vertex-coloured, flat-shaded geometry; materials
 * are created here so every mesh in the game shares one set of shader patches.
 */
export interface ModelEntry {
  id: string;
  label: string;
  kind: string;
  biomes: string[];
  desc: string;
  tris: number;
  lod1Tris: number | null;
  glow: boolean;
  /** [width, height, depth] in BU */
  size: [number, number, number];
  base: number;
  /** collision cylinder (r, h) or false for walk-through detail */
  /** one cylinder around the origin, or one per foot (an arch stands on two) */
  collide: { r: number; h: number } | { x: number; z: number; r: number; h: number }[] | false;
  material: { roughness?: number; metalness?: number };
  scale: [number, number];
  castShadow: boolean;
  sink: number;
  /** past this distance the far LOD is drawn */
  farCut: number;
  source?: 'prefab' | 'blender';
  /** where the game server serves a Blender-built model from (kept in the save) */
  url?: string;
}

export interface ModelGeos {
  entry: ModelEntry;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  glowNear: THREE.BufferGeometry | null;
  glowFar: THREE.BufferGeometry | null;
}

export interface LibraryManifest {
  version: number;
  blender?: string;
  generated?: string;
  glb?: string;
  models: Record<string, ModelEntry>;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * Per-instance opacity fade for the camera (an instanced float attribute the
 * material multiplies into alpha) and, for glow parts, vertex-coloured emission.
 */
function patchMaterial(m: THREE.MeshStandardMaterial, glow: boolean) {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vFade;\n#include <opaque_fragment>');
    if (glow) {
      // the glowing parts carry their own light colour in the vertex colour
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive * vColor.rgb;',
      );
    }
  };
  m.customProgramCacheKey = () => (glow ? 'mist-glow-fade' : 'mist-fade');
}

export function materialFor(entry: ModelEntry, glow: boolean): THREE.MeshStandardMaterial {
  const rough = glow ? 0.6 : entry.material.roughness ?? 0.88;
  const metal = glow ? 0 : entry.material.metalness ?? 0;
  const key = `${glow ? 'g' : 'b'}:${rough}:${metal}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: rough,
    metalness: metal,
    // blades and fronds are single-surface ribbons
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    forceSinglePass: true,
    // The mist wall owns the frontier; distance fog must not wash out authored prop colours.
    fog: false,
  });
  if (glow) {
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = 0.85;
  }
  patchMaterial(m, glow);
  matCache.set(key, m);
  return m;
}

/**
 * GLB colour attribute -> float rgb. `getX()` & co. already return denormalised
 * 0..1 values for normalised integer attributes, so nothing is scaled here:
 * dividing again turned every vertex colour into near-zero (black) models.
 */
function rgbAttribute(src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const col = src as THREE.BufferAttribute;
  if (col.itemSize === 3 && col.array instanceof Float32Array && !col.normalized) return col;
  const out = new Float32Array(col.count * 3);
  for (let i = 0; i < col.count; i++) {
    out[i * 3] = col.getX(i);
    out[i * 3 + 1] = col.getY(i);
    out[i * 3 + 2] = col.getZ(i);
  }
  return new THREE.BufferAttribute(out, 3);
}

/**
 * Keep only what the instanced renderer needs (position, colour, index); flat
 * shading makes the normal attribute redundant. `getX()` already returns
 * denormalised 0..1 values for normalised integer attributes, so a Uint16
 * colour from the GLB needs no further scaling.
 */
function slim(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  geo.setAttribute('position', new THREE.BufferAttribute(pos.array as Float32Array, pos.itemSize));
  const col = src.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (col) geo.setAttribute('color', rgbAttribute(col));
  geo.setIndex(src.index ? src.index : null);
  geo.computeBoundingSphere();
  return geo;
}

export class AssetLibrary {
  readonly models = new Map<string, ModelGeos>();
  manifest: LibraryManifest = { version: 0, models: {} };
  private loader = new GLTFLoader();
  private loading = new Map<string, Promise<ModelGeos>>();

  get(id: string): ModelGeos | undefined {
    return this.models.get(id);
  }

  /** Short catalog for the AI prompt: what already exists and what it looks like. */
  catalog(): { id: string; label: string; kind: string; biomes: string[]; desc: string; tris: number }[] {
    return Object.values(this.manifest.models).map((m) => ({ id: m.id, label: m.label, kind: m.kind, biomes: m.biomes, desc: m.desc, tris: m.tris }));
  }

  async loadPrefabs(url = '/models/prefabs.glb', manifestUrl = '/models/prefabs.json'): Promise<number> {
    const [gltf, man] = await Promise.all([this.loader.loadAsync(url), fetch(manifestUrl).then((r) => r.json() as Promise<LibraryManifest>)]);
    this.manifest = man;
    const byName = new Map<string, THREE.BufferGeometry[]>();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const list = byName.get(mesh.name) || [];
      list.push(mesh.geometry);
      byName.set(mesh.name, list);
    });
    let n = 0;
    for (const id of Object.keys(man.models)) {
      // a model may be nothing but light (the frost crystal landmark): no main mesh
      if (!byName.has(id) && !byName.has(id + '__glow')) continue;
      this.models.set(id, this.combine(man.models[id], byName));
      n++;
    }
    return n;
  }

  private combine(entry: ModelEntry, byName: Map<string, THREE.BufferGeometry[]>): ModelGeos {
    const pick = (name: string) => {
      const g = byName.get(name);
      return g && g.length ? slim(g[0]) : null;
    };
    const near = pick(entry.id);
    const far = pick(entry.id + '__lod1');
    return {
      entry,
      near: near ?? new THREE.BufferGeometry(),
      far: far ?? near ?? new THREE.BufferGeometry(),
      glowNear: pick(entry.id + '__glow'),
      glowFar: pick(entry.id + '__glow__lod1') ?? pick(entry.id + '__glow'),
    };
  }

  /**
   * A model Blender built for an AI-designed region (served by the game server).
   * Loading the same address again is a no-op, so every tile may list its models.
   */
  async loadGenerated(entry: ModelEntry, url: string): Promise<ModelGeos> {
    const pending = this.loading.get(entry.id);
    if (pending) return pending;
    const have = this.models.get(entry.id);
    if (have && this.manifest.models[entry.id]?.url === url) return have;
    const stored: ModelEntry = { ...entry, url };
    const p = this.loader
      .loadAsync(url)
      .then((gltf) => {
        const byName = new Map<string, THREE.BufferGeometry[]>();
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry) byName.set(mesh.name, [mesh.geometry]);
        });
        const g = this.combine(entry, byName);
        if (!g.near.attributes.position && !g.glowNear) throw new Error(`模型文件里没有「${entry.id}」的网格`);
        this.manifest.models[entry.id] = stored;
        this.models.set(entry.id, g);
        this.loading.delete(entry.id);
        return g;
      })
      .catch((e: unknown) => {
        // a failed load must not be remembered, or the model could never be fetched again
        this.loading.delete(entry.id);
        throw e;
      });
    this.loading.set(entry.id, p);
    return p;
  }

  /** The birth-island terrain as Blender exported it: chunk meshes keyed "cx,cz". */
  async loadTerrain(url: string): Promise<Map<string, THREE.BufferGeometry>> {
    const gltf = await this.loader.loadAsync(url);
    const out = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry && /^Chunk_-?\d+_-?\d+$/.test(mesh.name)) {
        const g = new THREE.BufferGeometry();
        const pos = mesh.geometry.getAttribute('position');
        g.setAttribute('position', new THREE.BufferAttribute(pos.array as Float32Array, 3));
        const col = mesh.geometry.getAttribute('color');
        if (col) g.setAttribute('color', rgbAttribute(col));
        g.setIndex(mesh.geometry.index ? mesh.geometry.index : null);
        // key "cx,cz" — the same spelling buildWorld() looks chunks up by
        g.name = mesh.name.replace('Chunk_', '').replace('_', ',');
        out.set(g.name, g);
      }
    });
    return out;
  }

  dispose() {
    for (const g of this.models.values()) {
      g.near.dispose();
      if (g.far !== g.near) g.far.dispose();
      g.glowNear?.dispose();
      g.glowFar?.dispose();
    }
    this.models.clear();
  }
}
