import * as THREE from 'three';
import type { IslandField } from './world';
import { SUN_DIR } from './palette';

/**
 * The sea and every lake: one surface at sea level over the whole world, coloured
 * by how deep the floor is under it.
 *
 * The depth is read from the terrain into each vertex, so the shallows are clear
 * turquoise over the sand, the deep water stays dark, and a band of foam breaks
 * exactly where the floor rises to meet the surface — on the shore of a lake as
 * much as on the open coast. Waves move the surface in the vertex shader; the
 * facets come from the screen-space derivative of that surface, which keeps the
 * low-poly look of the rest of the world without any normal pass.
 *
 * Near the player the surface is a grid of chunks that each carry real depths;
 * beyond them one large sheet of deep water runs to the horizon under the mist.
 * Chunks are created as the player moves and refreshed when a region is opened.
 */

/** edge of one near chunk, in BU */
const CHUNK_BU = 20;
/** cells along a chunk edge: facets about the size of the terrain's */
const CELLS = 10;
/** depth written into the far sheet: always the deep colour */
const FAR_DEPTH = 30;

const VERT = /* glsl */ `
attribute float aFloor; // signed height of the ground under this vertex
uniform float uTime;
varying vec3 vWorld;
varying float vDepth;
varying float vFloor;
varying vec2 vSlope;

// wave(x, z) = amp * sin(dot(k, p) + speed * t); returns its height and slope
vec3 wave(vec2 k, float amp, float speed, vec2 p, float t) {
  float ph = dot(k, p) + speed * t;
  return vec3(amp * sin(ph), amp * cos(ph) * k);
}

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float depth = max(0.0, -aFloor);
  // the swell lies down where the water is shallow, so no wave climbs over a beach
  float calm = smoothstep(0.0, 1.6, depth);
  float t = uTime;
  vec2 p = w.xz;
  vec3 r = vec3(0.0);
  // a long swell from two directions, a shorter chop, and two fine ripples for the glints
  r += wave(vec2(0.19, 0.07), 0.085, 0.85, p, t);
  r += wave(vec2(-0.06, 0.21), 0.07, 0.65, p, t + 1.7);
  r += wave(vec2(0.33, -0.27), 0.034, 1.3, p, t + 0.6);
  r += wave(vec2(0.95, 0.75), 0.012, 2.1, p, t);
  r += wave(vec2(-1.3, 0.9), 0.008, 2.6, p, t + 2.2);
  r *= calm;
  w.y += r.x;
  vWorld = w.xyz;
  vDepth = depth;
  vFloor = aFloor;
  vSlope = r.yz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform vec3 uCam;
uniform vec2 uNearMin;
uniform vec2 uNearMax;
varying vec3 vWorld;
varying float vDepth;
varying float vFloor;
varying vec2 vSlope;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  // the far sheet only exists where no near chunk covers the water (it is the only
  // water with a depth no real floor reaches)
  if (vDepth > 20.0 && all(greaterThan(vWorld.xz, uNearMin)) && all(lessThan(vWorld.xz, uNearMax))) discard;
  // a sand flat a hair above the tide is LAND: without this the sheet, its waves and
  // its foam lie on top of the beach, and a low bank reads as a white plate
  if (vFloor > 0.02) discard;

  // the surface's own slope gives a smooth normal that the light glides over; a
  // little of the flat facet is mixed in so the sea belongs to a faceted world
  vec3 n = normalize(vec3(-vSlope.x, 1.0, -vSlope.y));
  vec3 facet = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(facet, n) < 0.0) facet = -facet;
  n = normalize(mix(n, facet, 0.22));
  bool below = !gl_FrontFacing;
  vec3 nEye = below ? -n : n;

  vec3 toEye = uCam - vWorld;
  float dist = length(toEye);
  vec3 v = toEye / dist;
  float d = vDepth;

  // colour by depth: clear turquoise by the shore, deep teal far out
  vec3 col = mix(uShallow, uMid, smoothstep(0.35, 3.0, d));
  col = mix(col, uDeep, smoothstep(2.8, 8.5, d));
  // the sky at grazing angles
  float fres = pow(1.0 - max(dot(nEye, v), 0.0), 4.0);
  col = mix(col, uSky, fres * 0.2);
  // sun on the water: a soft sheen on the facing slopes and a tight sparkle on the ripples
  vec3 h = normalize(uSunDir + v);
  float sheen = pow(max(dot(nEye, h), 0.0), 28.0);
  float sparkle = pow(max(dot(nEye, h), 0.0), 260.0);
  col += uSunColor * (sheen * 0.12 + sparkle * 0.6);

  // Foam is a band a fraction of a BU WIDE along the shore, so it has to be measured
  // in distance, not in depth: on a flat tidal flat a depth band would cover the whole
  // flat as a white plate. The floor's own slope tells us how many BU a metre of depth
  // is worth, and the band follows the shore at a constant width.
  float pxBU = max(length(vec2(dFdx(vWorld.x), dFdy(vWorld.x))), 1e-4);
  float slopePerBU = max(length(vec2(dFdx(vFloor), dFdy(vFloor))) / pxBU, 1e-4);
  float band = clamp(0.75 * slopePerBU, 0.012, 0.5);
  float ragged = vnoise(vWorld.xz * 1.5 + vec2(uTime * 0.2, -uTime * 0.16)) * 0.6
               + vnoise(vWorld.xz * 4.1 - vec2(uTime * 0.27, uTime * 0.11)) * 0.4;
  float breath = sin(uTime * 1.05 + vWorld.x * 0.045 + vWorld.z * 0.038) * 0.2;
  float edge = d - breath * band - (ragged - 0.5) * 0.55 * band;
  float foam = 1.0 - smoothstep(0.0, band, edge);
  float lace = smoothstep(0.42, 0.8, ragged + foam * 0.5);
  // a second, fainter wave line a little further out
  float line = 1.0 - smoothstep(0.0, band * 0.4, abs(edge - band * 1.5));
  float white = max(foam * (0.35 + 0.65 * lace), line * smoothstep(0.42, 0.66, ragged) * 0.3);
  white = below ? white * 0.15 : white;
  col = mix(col, uFoam, white);

  // shallow water lets the sand show through; the deep sea is nearly opaque
  float alpha = mix(0.55, 0.96, smoothstep(0.0, 1.6, d));
  alpha = max(alpha, white * 0.92);

  if (below) {
    // seen from under the surface: a bright, silvery ceiling
    col = mix(col, uSky, 0.55 + fres * 0.3);
    alpha = 0.92;
  }

  // the mist takes the water later than it takes the land, so the sea stays blue
  // out to where the mist wall stands
  float fog = smoothstep(uFogNear * 1.7, uFogFar * 1.3, dist);
  col = mix(col, uFogColor, fog);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Water {
  readonly group = new THREE.Group();
  private field: IslandField;
  private mat: THREE.ShaderMaterial;
  /** chunks around the player that carry the real depth of the floor */
  private near = new Map<number, THREE.Mesh>();
  private far: THREE.Mesh;
  private positions: THREE.BufferAttribute;
  private index: THREE.BufferAttribute;
  /** how many chunks of real depth reach out from the player in each direction */
  private reach = 4;
  private reachWanted = 4;
  private cx = NaN;
  private cz = NaN;
  private time = 0;

  constructor(field: IslandField) {
    this.field = field;
    this.group.name = 'Water';

    // one shared grid: every near chunk has the same shape and only its depths differ
    const verts = CELLS + 1;
    const pos = new Float32Array(verts * verts * 3);
    const idx: number[] = [];
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const o = (j * verts + i) * 3;
        pos[o] = (i / CELLS - 0.5) * CHUNK_BU;
        pos[o + 1] = 0;
        pos[o + 2] = (j / CELLS - 0.5) * CHUNK_BU;
      }
    }
    // a is the top-left corner of a cell, b right of it, c below it, d diagonally opposite.
    // The diagonal alternates so no direction is preferred; every triangle is wound
    // to face up.
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
    this.positions = new THREE.BufferAttribute(pos, 3);
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x46cfc3) },
        uMid: { value: new THREE.Color(0x1a8db3) },
        uDeep: { value: new THREE.Color(0x10517e) },
        uFoam: { value: new THREE.Color(0xffffff) },
        uSky: { value: new THREE.Color(0xd6eef4) },
        uSunDir: { value: new THREE.Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).normalize() },
        uSunColor: { value: new THREE.Color(0xfff3d6) },
        uFogColor: { value: new THREE.Color(0xffffff) },
        uFogNear: { value: 20 },
        uFogFar: { value: 60 },
        uCam: { value: new THREE.Vector3() },
        uNearMin: { value: new THREE.Vector2() },
        uNearMax: { value: new THREE.Vector2() },
      },
    });

    // deep water to the horizon; it follows the player, and the waves are a function
    // of world position so following does not make the pattern slide
    const farGeo = new THREE.PlaneGeometry(1600, 1600, 96, 96);
    farGeo.rotateX(-Math.PI / 2);
    const n = farGeo.getAttribute('position').count;
    farGeo.setAttribute('aFloor', new THREE.BufferAttribute(new Float32Array(n).fill(-FAR_DEPTH), 1));
    this.far = new THREE.Mesh(farGeo, this.mat);
    this.far.name = 'Water_Far';
    this.far.frustumCulled = false;
    this.far.renderOrder = -0.5;
    this.group.add(this.far);
  }

  /**
   * How far out (BU) the water knows the floor: a little past the fog, so no shore
   * is ever drawn as deep sea. Capped: a very long view would need hundreds of
   * chunks for shores that the mist has all but hidden anyway.
   */
  setReach(fogFar: number) {
    this.reachWanted = Math.min(5, Math.max(2, Math.ceil((fogFar + 14) / CHUNK_BU)));
  }

  /** A new world (a new seed): every chunk reads the floor again. */
  setField(field: IslandField) {
    this.field = field;
  }

  refreshAll() {
    for (const m of this.near.values()) this.sample(m, Math.round(m.position.x / CHUNK_BU), Math.round(m.position.z / CHUNK_BU));
  }

  /** Depths of the floor under one chunk, written into its attribute. */
  private sample(chunk: THREE.Mesh, cx: number, cz: number) {
    const depth = chunk.geometry.getAttribute('aFloor') as THREE.BufferAttribute;
    const pos = this.positions;
    const ox = cx * CHUNK_BU;
    const oz = cz * CHUNK_BU;
    for (let i = 0; i < depth.count; i++) {
      depth.setX(i, this.field.height(ox + pos.getX(i), oz + pos.getZ(i)));
    }
    depth.needsUpdate = true;
  }

  private addChunk(cx: number, cz: number) {
    const key = (cx + 512) * 4096 + (cz + 512);
    if (this.near.has(key)) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.positions);
    geo.setIndex(this.index);
    geo.setAttribute('aFloor', new THREE.BufferAttribute(new Float32Array(this.positions.count), 1));
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.position.set(cx * CHUNK_BU, 0, cz * CHUNK_BU);
    mesh.name = `Water_${cx}_${cz}`;
    // the grid is shared, so the bounds cannot be computed from it
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), CHUNK_BU * 0.75 + 0.8);
    this.near.set(key, mesh);
    this.sample(mesh, cx, cz);
    this.group.add(mesh);
  }

  /** Lays the near chunks out around the player, creating and dropping them as they go. */
  private follow(px: number, pz: number) {
    const ccx = Math.floor(px / CHUNK_BU);
    const ccz = Math.floor(pz / CHUNK_BU);
    if (ccx === this.cx && ccz === this.cz && this.reach === this.reachWanted) return;
    if (this.reach !== this.reachWanted) {
      this.reach = this.reachWanted;
      for (const [key, m] of this.near) {
        this.group.remove(m);
        m.geometry.dispose();
        this.near.delete(key);
      }
    }
    this.cx = ccx;
    this.cz = ccz;
    const r = this.reach;
    for (const [key, m] of this.near) {
      const x = m.position.x / CHUNK_BU;
      const z = m.position.z / CHUNK_BU;
      if (Math.abs(x - ccx) > r || Math.abs(z - ccz) > r) {
        this.group.remove(m);
        m.geometry.dispose();
        this.near.delete(key);
      }
    }
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) this.addChunk(ccx + i, ccz + j);
    const half = (r + 0.5) * CHUNK_BU;
    (this.mat.uniforms.uNearMin.value as THREE.Vector2).set(ccx * CHUNK_BU - half, ccz * CHUNK_BU - half);
    (this.mat.uniforms.uNearMax.value as THREE.Vector2).set(ccx * CHUNK_BU + half, ccz * CHUNK_BU + half);
  }

  /**
   * The ground changed under a rectangle of the world (a region was opened):
   * every near chunk that overlaps it reads the floor again.
   */
  refresh(x0: number, z0: number, x1: number, z1: number) {
    for (const m of this.near.values()) {
      const mx = m.position.x;
      const mz = m.position.z;
      const h = CHUNK_BU * 0.5;
      if (mx + h < x0 || mx - h > x1 || mz + h < z0 || mz - h > z1) continue;
      this.sample(m, Math.round(mx / CHUNK_BU), Math.round(mz / CHUNK_BU));
    }
  }

  update(dt: number, px: number, pz: number, camera: THREE.Camera, fog: THREE.Fog | null) {
    this.time += dt;
    this.follow(px, pz);
    this.far.position.set(px, 0, pz);
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    (u.uCam.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    if (fog) {
      (u.uFogColor.value as THREE.Color).copy(fog.color);
      u.uFogNear.value = fog.near;
      u.uFogFar.value = fog.far;
    }
  }

  dispose() {
    for (const m of this.near.values()) m.geometry.dispose();
    this.near.clear();
    this.far.geometry.dispose();
    this.mat.dispose();
  }
}
