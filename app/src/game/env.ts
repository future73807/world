import * as THREE from 'three';
import { PAL, SUN_DIR } from './palette';
import { mulberry32 } from '../lib/noise';
import { ensureOutward } from '../lib/gl';

/** The sun keeps its painted storybook face, now as a pure sprite effect. */
export function buildSky(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Sky_Effects';

  const sunDir = new THREE.Vector3(SUN_DIR.x, 0.07, SUN_DIR.z).normalize();
  const sunPos = sunDir.clone().multiplyScalar(380);

  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const paint = (radius: number, stops: [number, string][]) => {
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, radius);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
  };
  // wide halo, inner glow, then the ivory-gold body — painted back to front
  paint(128, [
    [0, 'rgba(255,212,110,0.30)'],
    [0.42, 'rgba(255,206,100,0.14)'],
    [0.72, 'rgba(255,200,95,0.05)'],
    [1, 'rgba(255,200,95,0)'],
  ]);
  paint(96, [
    [0, 'rgba(255,226,142,0.42)'],
    [0.55, 'rgba(255,214,118,0.18)'],
    [1, 'rgba(255,214,118,0)'],
  ]);
  paint(58, [
    [0, '#fffdf1'],
    [0.5, '#fff3c4'],
    [0.74, '#ffd873'],
    [0.86, 'rgba(255,208,105,0.5)'],
    [0.94, 'rgba(255,208,105,0)'],
  ]);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    }),
  );
  sun.position.copy(sunPos);
  // 380 BU away, ~52 world units across ≈ 7.6° — clear but not overwhelming.
  // renderOrder sits ABOVE the mist wall (8–11): the sun glows through the fog
  // instead of being washed out behind it; terrain still occludes via depth.
  sun.scale.setScalar(104);
  sun.renderOrder = 12;
  sun.frustumCulled = false;
  group.add(sun);

  return group;
}

/** Distant floating islets — the silhouette that says "floating world", not "coastal hill". */
export function buildFarIslets(seed: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Far_Islets';
  const rnd = mulberry32(seed + 991);

  const grassTop = new THREE.Color(PAL.canopyATop);
  const rockA = new THREE.Color(PAL.rockMid);
  const rockB = new THREE.Color(PAL.rockDark);
  const sandEdge = new THREE.Color(PAL.sandLight);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  });

  const count = 11;
  for (let i = 0; i < count; i++) {
    const radius = 2.6 + rnd() * 6.4;
    const sides = 9 + Math.floor(rnd() * 4);
    const depth = radius * (1.5 + rnd() * 1.6);
    const ripple = 0.14 + rnd() * 0.16;

    // single closed body: grassy tabletop → rocky strata → tapered underside
    const ring = (r: number, y: number, wob: number, jitterPhase: number) => {
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const w = 1 + Math.sin(a * 3 + jitterPhase) * wob + Math.sin(a * 5 - jitterPhase) * wob * 0.6;
        pts.push(new THREE.Vector3(Math.cos(a) * r * w, y, Math.sin(a) * r * w));
      }
      return pts;
    };

    const top = ring(radius * 0.72, radius * 0.1, ripple * 0.5, i * 1.7);
    const lip = ring(radius, 0, ripple, i * 2.3);
    const lipLow = ring(radius * 0.97, -radius * 0.14, ripple, i * 2.9);
    const mid = ring(radius * 0.8, -depth * 0.34, ripple * 1.3, i * 3.4);
    const low = ring(radius * 0.45, -depth * 0.72, ripple * 1.6, i * 4.1);
    const bottom = new THREE.Vector3(radius * 0.12, -depth, radius * 0.08);

    const posArr: number[] = [];
    const colArr: number[] = [];
    const pushTri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, col: THREE.Color) => {
      // outward winding about the body's own axis
      posArr.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
      for (let k = 0; k < 3; k++) colArr.push(col.r, col.g, col.b);
    };

    const bands: [THREE.Vector3[], THREE.Vector3[], THREE.Color][] = [
      [top, lip, grassTop],
      [lip, lipLow, sandEdge],
      [lipLow, mid, rockA],
      [mid, low, rockB],
      [low, [], rockB],
    ];

    for (let b = 0; b < 4; b++) {
      const [a, c, col] = bands[b];
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        pushTri(a[s], c[s], c[s2], col);
        pushTri(a[s], c[s2], a[s2], col);
      }
    }
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      pushTri(low[s], bottom, low[s2], rockB);
    }
    // cap the grass table
    const centreTop = new THREE.Vector3(0, radius * 0.14, 0);
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      pushTri(top[s2], centreTop, top[s], grassTop);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(ensureOutward(geo), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const angle = (i / count) * Math.PI * 2 + rnd() * 0.5;
    const dist = 115 + rnd() * 165;
    mesh.position.set(Math.cos(angle) * dist, -22 + rnd() * 40, Math.sin(angle) * dist);
    mesh.rotation.y = rnd() * Math.PI * 2;
    mesh.scale.setScalar(0.85 + rnd() * 0.7);

    // a few small trees on the larger islets, kept as simple silhouettes
    if (radius > 5.2) {
      const trunkH = Math.min(radius * 0.42, 2.4);
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.022, radius * 0.036, trunkH, 5),
        new THREE.MeshStandardMaterial({ color: PAL.barkMid, flatShading: true, roughness: 0.9 }),
      );
      trunk.position.y = radius * 0.14 + trunkH / 2;
      mesh.add(trunk);
      const crown = new THREE.Mesh(
        new THREE.IcosahedronGeometry(radius * 0.19, 0),
        new THREE.MeshStandardMaterial({ color: PAL.canopyASide, flatShading: true, roughness: 0.9 }),
      );
      crown.scale.set(1.2, 0.78, 1.2);
      crown.position.y = radius * 0.14 + trunkH + radius * 0.1;
      mesh.add(crown);
    }

    group.add(mesh);
  }

  return group;
}

/** Animated sea: faceted low-poly waves plus a wide shallow-water ring. */
export class Sea {
  readonly mesh: THREE.Mesh;
  readonly foamMesh: THREE.Mesh;
  private geo: THREE.PlaneGeometry;
  private basePositions: Float32Array;
  private readonly radius = 420;
  private time = 0;
  private readonly segs = 110;

  constructor() {
    this.geo = new THREE.PlaneGeometry(this.radius * 2, this.radius * 2, this.segs, this.segs);
    this.geo.rotateX(-Math.PI / 2);
    this.basePositions = Float32Array.from(this.geo.getAttribute('position').array as Float32Array);

    const count = this.geo.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    const deep = new THREE.Color(PAL.waterDeep);
    const shallow = new THREE.Color(PAL.waterShallow);
    const mid = new THREE.Color(PAL.waterMid);
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getZ(i));
      const c = deep
        .clone()
        .lerp(mid, THREE.MathUtils.clamp(1 - d / 210, 0, 1))
        .lerp(shallow, Math.max(0, 1 - d / 68) * 0.9);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.14,
      metalness: 0.34,
      transparent: true,
      opacity: 0.96,
      envMapIntensity: 1.15,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'Water_Surface';

    // sparkle ribbon: a thin brighter sheet just under the surface near shore
    const foamGeo = new THREE.RingGeometry(30, 130, 64, 6);
    foamGeo.rotateX(-Math.PI / 2);
    const foamMat = new THREE.MeshBasicMaterial({
      color: PAL.waterShallow,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.foamMesh = new THREE.Mesh(foamGeo, foamMat);
    this.foamMesh.position.y = 0.045;
    this.foamMesh.name = 'Water_ShallowRing';
  }

  update(dt: number) {
    this.time += dt;
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const t = this.time;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = this.basePositions[i];
      const z = this.basePositions[i + 2];
      const d = Math.hypot(x, z);
      const fade = THREE.MathUtils.clamp(1 - d / 210, 0, 1);
      const w =
        Math.sin(x * 0.075 + t * 0.72) * 0.2 +
        Math.sin(z * 0.062 - t * 0.58) * 0.17 +
        Math.sin((x + z) * 0.115 + t * 1.05) * 0.09 +
        Math.sin((x - z) * 0.032 - t * 0.35) * 0.12;
      arr[i + 1] = w * fade;
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

/**
 * Dense mist bank around the known world — the frontier must FULLY occlude
 * whatever lies beyond (open sea, unbuilt land), while leaving the sky itself
 * visible. Heights are tuned to the fixed camera: from a standing eye (~9 BU)
 * the inner wall's top sits ~+4.7° above the horizon — every degree of sea and
 * distance is hidden, and only the outermost faint haze grazes the frame top.
 */
function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  // WHITE cumulus: luminous white body with only the faintest cool tint at the
  // underside — the fog must read bright, never like a storm front
  const blobs: [number, number, number, number][] = [
    [64, 74, 42, 1],
    [42, 60, 30, 0.9],
    [86, 58, 32, 0.9],
    [64, 44, 30, 0.95],
    [28, 80, 22, 0.8],
    [100, 82, 24, 0.8],
    [64, 92, 34, 0.85],
  ];
  for (const [x, y, r, a] of blobs) {
    const grad = g.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.6, `rgba(240,249,253,${a * 0.6})`);
    grad.addColorStop(1, 'rgba(222,240,248,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  // whisper of a cool base so the shape keeps some volume
  const shade = g.createLinearGradient(0, 76, 0, 128);
  shade.addColorStop(0, 'rgba(214, 236, 246, 0)');
  shade.addColorStop(1, 'rgba(202, 228, 240, 0.4)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The frontier: a hard-ish white "air wall" behind, and a front layer of
 * drifting particle puffs. The wall is what actually occludes the unbuilt
 * world; the puffs are the part the player brushes through, which is why they
 * are dense, layered in two depth bands, and animated.
 */
export function buildMistRing(innerR: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Mist_Wall';
  const rnd = mulberry32(911);

  // far strata — the "air wall" behind the particles
  const layers = [
    { y: 0, op: 0.55, r: innerR * 1.07, h: 21, seg: 96 },
    { y: 0.5, op: 0.3, r: innerR * 1.16, h: 22, seg: 96 },
  ];
  layers.forEach((l, i) => {
    const geo = new THREE.CylinderGeometry(l.r, l.r * 1.012, l.h, l.seg, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: l.op,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = l.y;
    mesh.renderOrder = 8 + i;
    group.add(mesh);
  });

  // Front particle band: two depth shells so the frontier has thickness when
  // you walk into it. Each puff keeps its own colour / opacity / drift phase.
  const tex = puffTexture();
  const tints = [0xffffff, 0xf8fcfe, 0xeef6fa, 0xffffff];
  const shells = [
    { rMul: 0.975, n: 1.9, sMin: 7.5, sMax: 14, opMin: 0.7, opMax: 0.96, order: 11 },
    { rMul: 1.035, n: 2.6, sMin: 10, sMax: 19, opMin: 0.5, opMax: 0.8, order: 10 },
  ];

  for (const shell of shells) {
    const puffs = Math.max(72, Math.ceil((innerR * Math.PI * 2) / shell.n));
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + (rnd() - 0.5) * 0.06;
      const r = innerR * (shell.rMul + (rnd() - 0.5) * 0.03);
      const s = shell.sMin + rnd() * (shell.sMax - shell.sMin);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: tints[Math.floor(rnd() * tints.length)],
        transparent: true,
        opacity: shell.opMin + rnd() * (shell.opMax - shell.opMin),
        depthWrite: false,
        depthTest: true,
        fog: false,
      });
      const sp = new THREE.Sprite(mat);
      const y = 4.8 + rnd() * 10.5;
      sp.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      sp.scale.set(s, s * 0.6, 1);
      sp.renderOrder = shell.order;
      // per-puff drift so the band breathes instead of being a fixed ring
      sp.userData.baseY = y;
      sp.userData.baseX = sp.position.x;
      sp.userData.baseZ = sp.position.z;
      sp.userData.phase = rnd() * Math.PI * 2;
      sp.userData.amp = 0.5 + rnd() * 1.1;
      sp.userData.drift = 0.25 + rnd() * 0.4;
      sp.userData.radial = (rnd() - 0.5) * 0.9;
      group.add(sp);
    }
  }

  return group;
}

/** Animates the frontier puffs: slow vertical breathing plus a lateral drift. */
export function updateMistRing(group: THREE.Group, t: number) {
  for (const child of group.children) {
    const d = child.userData;
    if (typeof d.phase !== 'number') continue;
    const ph = d.phase;
    child.position.y = d.baseY + Math.sin(t * 0.24 + ph) * d.amp;
    // drift tangentially: rotate the base point around the ring centre
    const ang = Math.atan2(d.baseZ, d.baseX) + Math.sin(t * d.drift * 0.12 + ph) * 0.004;
    const rad = Math.hypot(d.baseX, d.baseZ) + Math.sin(t * 0.18 + ph * 1.7) * d.radial;
    child.position.x = Math.cos(ang) * rad;
    child.position.z = Math.sin(ang) * rad;
  }
}
