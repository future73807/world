import * as THREE from 'three';
import { PAL } from './palette';
import { tube, foliageClump, featherBlade, grassBlade, blob, merge, paint } from '../lib/gl';
import { mulberry32, lerp } from '../lib/noise';

/**
 * Tree A — 折伞树 (warm lowland broadleaf).
 * S-curved trunk with root flare and a crown built from lobed foliage clumps.
 * Target 800–1,200 tris for the near asset.
 */
export function buildTreeA(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];

  const height = lerp(3.4, 4.5, rnd());
  const bend = lerp(-0.28, 0.28, rnd());
  const lean = lerp(-0.16, 0.16, rnd());

  const trunkPts = [
    new THREE.Vector3(0, -0.32, 0),
    new THREE.Vector3(bend * 0.22, height * 0.16, lean * 0.2),
    new THREE.Vector3(bend * 0.5, height * 0.42, lean * 0.5),
    new THREE.Vector3(bend * 0.92, height * 0.7, lean * 0.85),
    new THREE.Vector3(bend * 1.15, height * 0.92, lean * 1.1),
  ];
  const trunkR = [0.34, 0.27, 0.2, 0.145, 0.085];
  parts.push(paint(tube(trunkPts, trunkR, 9, { color: PAL.barkMid }), PAL.barkMid));

  // root flare — buttress roots with real cross-section
  const roots = 4;
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + rnd() * 0.5;
    const len = lerp(0.6, 0.95, rnd());
    parts.push(
      paint(
        tube(
          [
            new THREE.Vector3(0, 0.5, 0),
            new THREE.Vector3(Math.cos(a) * len * 0.45, 0.3, Math.sin(a) * len * 0.45),
            new THREE.Vector3(Math.cos(a) * len * 0.85, 0.02, Math.sin(a) * len * 0.85),
            new THREE.Vector3(Math.cos(a) * len * 1.05, -0.22, Math.sin(a) * len * 1.05),
          ],
          [0.24, 0.18, 0.12, 0.05],
          6,
          { color: PAL.barkDark },
        ),
        PAL.barkDark,
      ),
    );
  }

  // branches reaching into the crown
  const branches = 4 + Math.floor(rnd() * 2);
  const crownCentre = new THREE.Vector3(bend * 0.95, height * 0.8, lean * 0.95);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rnd() * 0.5;
    const reach = lerp(0.9, 1.7, rnd());
    const base = new THREE.Vector3(bend * 0.5, height * lerp(0.52, 0.72, rnd()), lean * 0.5);
    const tip = new THREE.Vector3(
      crownCentre.x + Math.cos(a) * reach,
      crownCentre.y + lerp(-0.15, 0.5, rnd()),
      crownCentre.z + Math.sin(a) * reach,
    );
    const mid = base.clone().lerp(tip, 0.55).add(new THREE.Vector3(0, 0.26, 0));
    parts.push(paint(tube([base, mid, tip], [0.12, 0.082, 0.045], 6, { color: PAL.barkMid }), PAL.barkMid));
  }

  // crown: overlapping clumps forming one broad lobed mass
  const clumps = [
    { r: 1.55, dx: 0, dy: 0.15, dz: 0 },
    { r: 1.2, dx: 1.15, dy: -0.15, dz: 0.25 },
    { r: 1.15, dx: -1.05, dy: 0.05, dz: -0.3 },
    { r: 1.02, dx: 0.25, dy: 0.55, dz: -0.85 },
    { r: 0.95, dx: -0.4, dy: -0.3, dz: 1.0 },
    { r: 0.85, dx: 0.55, dy: 0.72, dz: 0.6 },
  ];
  for (let i = 0; i < clumps.length; i++) {
    const c = clumps[i];
    const clump = foliageClump(
      c.r * lerp(0.92, 1.08, rnd()),
      2,
      { top: PAL.canopyATop, mid: PAL.canopyASide, under: PAL.canopyAUnder },
      seed + i * 37,
      0.86,
    );
    clump.translate(crownCentre.x + c.dx + (rnd() - 0.5) * 0.2, crownCentre.y + c.dy, crownCentre.z + c.dz + (rnd() - 0.5) * 0.2);
    parts.push(clump);
  }

  return merge(parts);
}

/**
 * Tree B — 叠羽树 (cool slope, layered soft crown).
 * Wind-bent segmented trunk with stacked feather layers, rounded by clump foliage
 * between the layers so it no longer reads as a bare conifer.
 */
export function buildTreeB(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];

  const height = lerp(4.0, 5.2, rnd());
  const wind = lerp(0.5, 0.95, rnd()) * (rnd() > 0.5 ? 1 : -1);

  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const segs = 6;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const sway = Math.pow(t, 1.7) * wind;
    pts.push(new THREE.Vector3(sway, t * height, sway * 0.28));
    radii.push(lerp(0.27, 0.05, Math.pow(t, 0.85)));
  }
  parts.push(paint(tube(pts, radii, 8, { color: PAL.barkCool }), PAL.barkCool));

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    parts.push(
      paint(
        tube(
          [
            new THREE.Vector3(0, 0.35, 0),
            new THREE.Vector3(Math.cos(a) * 0.3, 0.12, Math.sin(a) * 0.3),
            new THREE.Vector3(Math.cos(a) * 0.48, -0.2, Math.sin(a) * 0.48),
          ],
          [0.16, 0.11, 0.045],
          5,
          { color: PAL.barkDark },
        ),
        PAL.barkDark,
      ),
    );
  }

  // Layered crown: soft clump bodies carry the volume, with short feather blades
  // fringing each layer. Long horizontal blades turned the tree into a stack of
  // pancake shelves, so they are now edge detail, not the mass itself.
  const layers = 3 + Math.floor(rnd() * 2);
  for (let l = 0; l < layers; l++) {
    const t = 0.36 + (l / layers) * 0.58;
    const y = t * height;
    const sway = Math.pow(t, 1.7) * wind;
    const layerR = lerp(1.55, 0.6, Math.pow(t, 0.8));

    const body = foliageClump(
      layerR,
      2,
      { top: PAL.canopyBTop, mid: PAL.canopyBSide, under: PAL.canopyBUnder },
      seed + l * 53,
      0.86,
    );
    body.translate(sway, y, sway * 0.28);
    parts.push(body);

    // short blades only break the silhouette; they never extend past the clump
    const blades = 4 + Math.floor(rnd() * 2);
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * Math.PI * 2 + l * 1.15;
      const blade = featherBlade(layerR * lerp(0.42, 0.6, rnd()), lerp(0.2, 0.3, rnd()), 0.04, {
        top: PAL.canopyBTop,
        edge: PAL.canopyBSide,
        under: PAL.canopyBUnder,
      }, lerp(0.55, 0.8, rnd()), 3);
      blade.rotateZ(-0.55 + (rnd() - 0.5) * 0.2);
      blade.rotateY(a);
      blade.translate(sway + Math.cos(a) * layerR * 0.55, y - layerR * 0.28, sway * 0.28 + Math.sin(a) * layerR * 0.55);
      parts.push(blade);
    }
  }

  // crown tip
  const tipClump = foliageClump(0.62, 2, { top: PAL.canopyBTop, mid: PAL.canopyBSide, under: PAL.canopyBUnder }, seed + 991, 0.9);
  tipClump.translate(wind, height, wind * 0.28);
  parts.push(tipClump);

  return parts.length ? merge(parts) : new THREE.BufferGeometry();
}

/**
 * Tree C — 灯菌树 (lantern-fungus tree, strange/high ecology).
 * 3 curated variants; bent 10-sided stalk, four-zone cap with rim thickness + gills.
 */
export function buildTreeC(seed: number, variant = 0): THREE.BufferGeometry {
  const rnd = mulberry32(seed + variant * 733);
  const parts: THREE.BufferGeometry[] = [];

  const height = lerp(2.6, 3.4, rnd());
  const bendDir = rnd() * Math.PI * 2;
  const bendAmt = lerp(0.18, 0.42, rnd());

  const stalkPts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const segs = 8;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const sway = Math.sin(t * Math.PI * 0.9) * bendAmt;
    stalkPts.push(new THREE.Vector3(Math.cos(bendDir) * sway, t * height, Math.sin(bendDir) * sway));
    radii.push(0.23 * Math.pow(1 - t, 0.45) + 0.1);
  }
  parts.push(paint(tube(stalkPts, radii, 10, { color: PAL.canopyCStalk }), PAL.canopyCStalk));

  const supports = 5;
  for (let i = 0; i < supports; i++) {
    const a = (i / supports) * Math.PI * 2 + rnd();
    const len = lerp(0.34, 0.62, rnd());
    parts.push(
      paint(
        tube(
          [
            new THREE.Vector3(Math.cos(bendDir) * 0.06, 0.22, Math.sin(bendDir) * 0.06),
            new THREE.Vector3(Math.cos(a) * len * 0.55, 0.1, Math.sin(a) * len * 0.55),
            new THREE.Vector3(Math.cos(a) * len, -0.1, Math.sin(a) * len),
          ],
          [0.07, 0.045, 0.018],
          5,
          { color: PAL.canopyCStalk },
        ),
        PAL.canopyCStalk,
      ),
    );
  }

  const capTop = stalkPts[segs];
  const capY = capTop.y;
  const capR = lerp(1.3, 1.75, rnd());

  // dome cap: a squashed clump reads as a soft mushroom bell
  const dome = foliageClump(
    capR,
    2,
    { top: PAL.canopyCTop, mid: PAL.canopyCSide, under: PAL.canopyCUnder },
    seed + 555,
    0.5,
  );
  dome.translate(capTop.x, capY + capR * 0.28, capTop.z);
  parts.push(dome);

  // gills radiating under the cap
  const gills = variant === 1 ? 7 : 11;
  for (let g = 0; g < gills; g++) {
    const a = (g / gills) * Math.PI * 2;
    const len = capR * 0.74;
    const w = 0.055;
    const y0 = capY - 0.1;
    const gx = capTop.x;
    const gz = capTop.z;
    const px = Math.cos(a);
    const pz = Math.sin(a);
    const nx = -pz;
    const nz = px;
    const posArr = [
      gx + nx * w, y0, gz + nz * w,
      gx + px * len, y0 - 0.05, gz + pz * len,
      gx - nx * w, y0, gz - nz * w,
      gx + nx * w * 0.4, y0 - 0.17, gz + nz * w * 0.4,
      gx + px * len * 0.94, y0 - 0.26, gz + pz * len * 0.94,
      gx - nx * w * 0.4, y0 - 0.17, gz - nz * w * 0.4,
    ];
    const ggeo = new THREE.BufferGeometry();
    ggeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    ggeo.computeVertexNormals();
    parts.push(paint(ggeo, PAL.canopyCGill));
  }

  // glowing nodules under the rim
  const glowN = variant === 2 ? 5 : 8;
  for (let i = 0; i < glowN; i++) {
    const a = (i / glowN) * Math.PI * 2 + 0.3;
    const r = capR * lerp(0.36, 0.66, rnd());
    const g = blob(lerp(0.075, 0.135, rnd()), 0, PAL.canopyCGlow, (v) => {
      v.y *= 0.72;
    });
    g.translate(capTop.x + Math.cos(a) * r, capY - 0.16, capTop.z + Math.sin(a) * r);
    parts.push(g);
  }

  // secondary small cap for silhouette variation
  if (variant !== 1) {
    const ba = rnd() * Math.PI * 2;
    const bstart = new THREE.Vector3(capTop.x * 0.4, height * 0.5, capTop.z * 0.4);
    const bend2 = new THREE.Vector3(bstart.x + Math.cos(ba) * 0.42, height * 0.66, bstart.z + Math.sin(ba) * 0.42);
    parts.push(paint(tube([bstart, bend2], [0.06, 0.04], 6, { color: PAL.canopyCStalk }), PAL.canopyCStalk));
    const cap2 = foliageClump(0.42, 2, { top: PAL.canopyCTop, mid: PAL.canopyCSide, under: PAL.canopyCUnder }, seed + 313, 0.55);
    cap2.translate(bend2.x, bend2.y + 0.1, bend2.z);
    parts.push(cap2);
  }

  return merge(parts);
}

/**
 * Rock — smooth rounded boulder: soft silhouette, subtle strata, moss on top faces.
 */
export function buildRock(seed: number, variant: 0 | 1 = 0): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];

  const mainR = lerp(0.6, 1.15, rnd());
  const squash = lerp(0.56, 0.82, rnd());
  const pieces = variant === 0 ? 2 : 1;

  for (let s = 0; s < pieces; s++) {
    const r = mainR * lerp(0.72, 1, rnd());
    const geo = new THREE.IcosahedronGeometry(r, 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    const phases = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];

    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      const dir = p.clone().normalize();
      const lump =
        Math.sin(dir.x * 2.1 + phases[0]) * 0.06 +
        Math.sin(dir.z * 2.7 + phases[1]) * 0.05 +
        Math.sin(dir.y * 3.3 + phases[2]) * 0.035;
      p.multiplyScalar(1 + lump);
      p.y *= squash;
      if (p.y < -r * squash * 0.35) p.y = lerp(p.y, -r * squash * 0.35, 0.55);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    geo.computeVertexNormals();

    const colors = new Float32Array(pos.count * 3);
    const stoneLight = new THREE.Color(0xb3bcbc);
    const stoneMid = new THREE.Color(0x94a0a2);
    const stoneDeep = new THREE.Color(0x748084);
    const band = new THREE.Color(0xa3aca4);
    const moss = new THREE.Color(0x8fb46a);
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const ny = nrm.getY(i);
      const stripe = Math.sin(y * 7.5) * 0.5 + 0.5;
      const c = stoneDeep.clone().lerp(stoneMid, 0.4 + stripe * 0.45).lerp(stoneLight, Math.max(0, ny) * 0.4);
      if (stripe > 0.72) c.lerp(band, 0.32);
      if (ny > 0.45) c.lerp(moss, (ny - 0.45) * 0.9);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    geo.translate((rnd() - 0.5) * mainR * 0.9, r * squash * 0.62 + s * 0.12, (rnd() - 0.5) * mainR * 0.9);
    geo.rotateY(rnd() * Math.PI);
    parts.push(geo);
  }

  const out = merge(parts);
  out.computeVertexNormals();
  return out;
}

/**
 * A clump of meadow grass: broad tapered blades fanning from a common root.
 * Blades only — a solid mound underneath read as a pile of green stones.
 */
export function buildGrassTuft(seed: number, simple = false): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];

  // Dense soft clump: many short blades fanned evenly, each with its own
  // outward lean and a gentle S-curve so the mass reads as a tuft that bends
  // rather than a pincushion of identical spikes.
  const blades = simple ? 6 : 13 + Math.floor(rnd() * 5);
  const height = lerp(0.30, 0.46, rnd());
  for (let i = 0; i < blades; i++) {
    const t = i / blades;
    const len = height * lerp(0.7, 1.25, rnd());
    const blade = grassBlade(
      len,
      len * lerp(0.075, 0.115, rnd()),
      lerp(-0.62, 0.62, rnd()),
      0x74b25c,
      rnd(),
      // 3 segments is the sweet spot: enough to show the S-curve, and 25% fewer
      // triangles than 4. A near-field blade is 4 tri/segment either way.
      simple ? 2 : 3,
    );
    blade.rotateY(t * Math.PI * 2 + rnd() * 0.7);
    // two thirds of the blades lean outward from the centre, one third stands
    // near-vertical: a uniform outward fan looked like a sea urchin
    const lean = rnd() < 0.62 ? 0.2 + rnd() * 0.42 : rnd() * 0.16;
    blade.rotateZ(-lean);
    blade.translate((rnd() - 0.5) * 0.22, -0.02, (rnd() - 0.5) * 0.22);
    parts.push(blade);
  }
  return merge(parts);
}

/** Small flower: curved stem, 5 petals with thickness, soft colour variation. */
export function buildFlower(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const stemH = lerp(0.32, 0.52, rnd());
  const lean = (rnd() - 0.5) * 0.24;
  parts.push(
    paint(
      tube(
        [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(lean * 0.4, stemH * 0.55, lean * 0.2),
          new THREE.Vector3(lean, stemH, lean * 0.4),
        ],
        [0.022, 0.017, 0.012],
        4,
        { color: 0x6f9c5f },
      ),
      0x6f9c5f,
    ),
  );

  const petals = 5;
  const petalCol = [0xfdf6e2, 0xf7dcc8, 0xeaf3d8, 0xf9e4ea][Math.floor(rnd() * 4)];
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const petal = blob(0.085, 1, petalCol, (v) => {
      v.z *= 0.62;
      v.y *= 0.2;
      v.x *= 1.45;
    });
    petal.rotateY(a);
    petal.translate(Math.cos(a) * 0.075 + lean, stemH + 0.015, Math.sin(a) * 0.075 + lean * 0.4);
    parts.push(petal);
  }
  const core = blob(0.045, 1, 0xe8c06e, (v) => {
    v.y *= 0.7;
  });
  core.translate(lean, stemH + 0.03, lean * 0.4);
  parts.push(core);

  return merge(parts);
}

// ---------------------------------------------------------------------------
// Simplified distant variants. These keep the silhouette and palette of their
// near counterparts but drop secondary clumps, blades and gill detail, so the
// far half of the island costs a fraction of the triangles.
// ---------------------------------------------------------------------------

/** Distant 折伞树: trunk + two crown clumps, no roots or twigs. */
export function buildTreeASimple(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const height = lerp(3.4, 4.5, rnd());
  const bend = lerp(-0.28, 0.28, rnd());
  const parts: THREE.BufferGeometry[] = [];

  parts.push(
    paint(
      tube(
        [
          new THREE.Vector3(0, -0.2, 0),
          new THREE.Vector3(bend * 0.5, height * 0.45, 0),
          new THREE.Vector3(bend * 1.1, height * 0.9, 0),
        ],
        [0.3, 0.19, 0.08],
        6,
        { color: PAL.barkMid },
      ),
      PAL.barkMid,
    ),
  );

  const c1 = foliageClump(1.7, 1, { top: PAL.canopyATop, mid: PAL.canopyASide, under: PAL.canopyAUnder }, seed, 0.86);
  c1.translate(bend * 0.95, height * 0.82, 0);
  parts.push(c1);
  const c2 = foliageClump(1.1, 1, { top: PAL.canopyATop, mid: PAL.canopyASide, under: PAL.canopyAUnder }, seed + 5, 0.86);
  c2.translate(bend * 0.95 + 0.9, height * 0.7, 0.4);
  parts.push(c2);

  return merge(parts);
}

/** Distant 叠羽树: bent trunk + three stacked clumps. */
export function buildTreeBSimple(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const height = lerp(4.0, 5.2, rnd());
  const wind = lerp(0.5, 0.95, rnd()) * (rnd() > 0.5 ? 1 : -1);
  const parts: THREE.BufferGeometry[] = [];

  parts.push(
    paint(
      tube(
        [
          new THREE.Vector3(0, -0.2, 0),
          new THREE.Vector3(wind * 0.35, height * 0.5, wind * 0.1),
          new THREE.Vector3(wind, height * 0.95, wind * 0.28),
        ],
        [0.24, 0.14, 0.05],
        6,
        { color: PAL.barkCool },
      ),
      PAL.barkCool,
    ),
  );

  const layers = 3;
  for (let l = 0; l < layers; l++) {
    const t = 0.42 + (l / layers) * 0.55;
    const r = lerp(1.35, 0.6, t);
    const clump = foliageClump(r, 1, { top: PAL.canopyBTop, mid: PAL.canopyBSide, under: PAL.canopyBUnder }, seed + l * 17, 0.88);
    clump.translate(Math.pow(t, 1.7) * wind, t * height, Math.pow(t, 1.7) * wind * 0.28);
    parts.push(clump);
  }
  return merge(parts);
}

/** Distant 灯菌树: stalk + single dome cap. */
export function buildTreeCSimple(seed: number, variant = 0): THREE.BufferGeometry {
  const rnd = mulberry32(seed + variant * 733);
  const height = lerp(2.6, 3.4, rnd());
  const bendDir = rnd() * Math.PI * 2;
  const bendAmt = lerp(0.18, 0.42, rnd());
  const parts: THREE.BufferGeometry[] = [];

  const stalk = [
    new THREE.Vector3(0, -0.1, 0),
    new THREE.Vector3(Math.cos(bendDir) * bendAmt * 0.6, height * 0.55, Math.sin(bendDir) * bendAmt * 0.6),
    new THREE.Vector3(Math.cos(bendDir) * bendAmt, height, Math.sin(bendDir) * bendAmt),
  ];
  parts.push(paint(tube(stalk, [0.2, 0.13, 0.1], 6, { color: PAL.canopyCStalk }), PAL.canopyCStalk));

  const capR = lerp(1.3, 1.75, rnd());
  const dome = foliageClump(capR, 1, { top: PAL.canopyCTop, mid: PAL.canopyCSide, under: PAL.canopyCUnder }, seed + 555, 0.5);
  dome.translate(stalk[2].x, height + capR * 0.28, stalk[2].z);
  parts.push(dome);
  return merge(parts);
}

/** Distant rock: one low-detail icosphere with the same strata tint. */
export function buildRockSimple(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const mainR = lerp(0.6, 1.15, rnd());
  const squash = lerp(0.56, 0.82, rnd());
  const geo = new THREE.IcosahedronGeometry(mainR, 1);
  geo.scale(1.1, squash, 1.0);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color(0x94a0a2);
  const moss = new THREE.Color(0x8fb46a);
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    const col = c.clone().lerp(moss, Math.max(0, ny - 0.4) * 0.8);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}
