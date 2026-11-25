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

/**
 * Dense mist bank around the known world — the frontier must FULLY occlude
 * whatever lies beyond (open sea, unbuilt land), while leaving the sky itself
 * visible. Heights are tuned to the fixed camera: from a standing eye (~9 BU)
 * the inner wall's top sits ~+4.7° above the horizon — every degree of sea and
 * distance is hidden, and only the outermost faint haze grazes the frame top.
 */
export function puffTexture(): THREE.CanvasTexture {
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
 * A mist bank laid along a coastline: `stations` are points on the shore, each
 * with the unit vector that points toward the unknown. Two depth bands per
 * station — a dense low front the player brushes through, and a big faint wall
 * behind it — so the frontier has thickness and fully hides what lies beyond.
 */
export interface MistStation {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

export function buildMistAlong(stations: MistStation[], seed = 911): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Mist_Wall';
  const rnd = mulberry32(seed);
  const tex = puffTexture();
  const tints = [0xffffff, 0xf8fcfe, 0xeef6fa, 0xffffff];

  const add = (x: number, z: number, y: number, size: number, op: number, order: number) => {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: tints[Math.floor(rnd() * tints.length)],
      transparent: true,
      opacity: op,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z);
    sp.scale.set(size, size * 0.6, 1);
    sp.renderOrder = order;
    sp.userData.baseY = y;
    sp.userData.baseX = x;
    sp.userData.baseZ = z;
    sp.userData.phase = rnd() * Math.PI * 2;
    sp.userData.amp = 0.5 + rnd() * 1.1;
    sp.userData.drift = 0.25 + rnd() * 0.4;
    sp.userData.radial = (rnd() - 0.5) * 0.9;
    sp.userData.op0 = op;
    group.add(sp);
  };

  for (const st of stations) {
    for (let k = 0; k < 2; k++) {
      const off = 6.5 + rnd() * 3.5;
      const side = (rnd() - 0.5) * 3.4;
      add(st.x + st.nx * off - st.nz * side, st.z + st.nz * off + st.nx * side, 4.6 + rnd() * 9.5, 8 + rnd() * 6.5, 0.7 + rnd() * 0.26, 11);
    }
    const off = 14 + rnd() * 7;
    const side = (rnd() - 0.5) * 5;
    add(st.x + st.nx * off - st.nz * side, st.z + st.nz * off + st.nx * side, 7 + rnd() * 10, 15 + rnd() * 8, 0.5 + rnd() * 0.3, 10);
  }
  return group;
}

/** Scales every puff's opacity (1 = as authored); used to dissolve a bank as the frontier moves. */
export function setMistOpacity(group: THREE.Object3D, k: number) {
  group.traverse((o) => {
    const m = (o as THREE.Sprite).material as THREE.SpriteMaterial | undefined;
    if (m && typeof o.userData.op0 === 'number') m.opacity = o.userData.op0 * k;
  });
}

/**
 * A loose swirl of puffs inside a tile that is being generated: the in-world
 * "loading" state. Rotated by the engine while the region is being built.
 * (cx, cz) is the tile's centre: the player stands just outside the tile, and
 * puffs that still drift up to the lens are faded by updateFormingMist().
 */
export function buildFormingMist(cx: number, cz: number, seed = 515): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Mist_Forming';
  const rnd = mulberry32(seed);
  const tex = puffTexture();
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 2 + rnd() * 11;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.3 + rnd() * 0.25,
      depthWrite: false,
      fog: false,
    });
    const sp = new THREE.Sprite(mat);
    const size = 8 + rnd() * 7;
    sp.scale.set(size, size * 0.62, 1);
    sp.position.set(Math.cos(a) * r, 2.5 + rnd() * 8, Math.sin(a) * r);
    sp.renderOrder = 9;
    sp.userData.op = mat.opacity;
    sp.userData.phase = rnd() * Math.PI * 2;
    sp.userData.baseY = sp.position.y;
    sp.userData.r = r;
    sp.userData.a0 = a;
    sp.userData.spin = 0.12 + rnd() * 0.16;
    group.add(sp);
  }
  group.position.set(cx, 0, cz);
  return group;
}

/** `eye`, when given, is the camera: puffs within ~7 BU of it vanish, so the slime stays visible. */
export function updateFormingMist(group: THREE.Object3D, t: number, eye?: THREE.Vector3) {
  for (const child of group.children) {
    const d = child.userData;
    if (typeof d.r !== 'number') continue;
    const a = d.a0 + t * d.spin;
    child.position.x = Math.cos(a) * d.r;
    child.position.z = Math.sin(a) * d.r;
    child.position.y = d.baseY + Math.sin(t * 0.5 + d.phase) * 1.4;
    let k = 1;
    if (eye) {
      const dist = Math.hypot(child.position.x + group.position.x - eye.x, child.position.y - eye.y, child.position.z + group.position.z - eye.z);
      k = Math.min(1, Math.max(0, (dist - 7) / 10));
      k = k * k;
    }
    (child as THREE.Sprite).material.opacity = d.op * k;
  }
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
