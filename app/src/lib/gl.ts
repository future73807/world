import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise';

export type V3 = [number, number, number];

export function paint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Converts to non-indexed triangles with flat per-face normals: designed low-poly facets. */
export function faceted(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const cleaned = parts.map((p) => {
    const g = p.clone();
    // mergeGeometries requires identical attribute sets
    const keep = ['position', 'normal', 'color'];
    for (const name of Object.keys(g.attributes)) {
      if (!keep.includes(name)) g.deleteAttribute(name);
    }
    if (!g.getAttribute('color')) paint(g, 0xffffff);
    // each part is corrected about its own centre before merging
    const fixed = ensureOutward(g);
    if (!fixed.getAttribute('normal')) fixed.computeVertexNormals();
    return fixed;
  });
  const out = mergeGeometries(cleaned, false);
  if (!out) throw new Error('geometry merge failed');
  return out;
}

/**
 * Hand-built triangle soup often ends up with some faces wound inward, which reads
 * as black facets under directional light. For closed-ish volumes we can fix this
 * deterministically: if a face normal points back toward the hull centre, flip it.
 */
export function ensureOutward(geo: THREE.BufferGeometry, centre?: THREE.Vector3): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;

  let c = centre;
  if (!c) {
    g.computeBoundingSphere();
    c = g.boundingSphere ? g.boundingSphere.center.clone() : new THREE.Vector3();
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const out = new THREE.Vector3();
  let flipped = 0;

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    d.fromBufferAttribute(pos, i + 2);
    nrm.subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    if (nrm.lengthSq() < 1e-12) continue;
    mid.copy(a).add(b).add(d).multiplyScalar(1 / 3);
    out.subVectors(mid, c);
    if (nrm.dot(out) < 0) {
      // swap the two trailing vertices to reverse the winding
      const px = pos.getX(i + 1);
      const py = pos.getY(i + 1);
      const pz = pos.getZ(i + 1);
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      pos.setXYZ(i + 2, px, py, pz);
      const color = g.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (color) {
        const cr = color.getX(i + 1);
        const cg = color.getY(i + 1);
        const cb = color.getZ(i + 1);
        color.setXYZ(i + 1, color.getX(i + 2), color.getY(i + 2), color.getZ(i + 2));
        color.setXYZ(i + 2, cr, cg, cb);
      }
      flipped++;
    }
  }

  pos.needsUpdate = true;
  const colorAttr = g.getAttribute('color');
  if (colorAttr) colorAttr.needsUpdate = true;
  g.computeVertexNormals();
  if (flipped > 0) g.userData.flipped = flipped;
  return g;
}

function lerpV3(a: THREE.Vector3, b: THREE.Vector3, t: number) {
  return new THREE.Vector3().lerpVectors(a, b, t);
}

/**
 * Sweeps a closed tube along a polyline with per-point radii and an optional
 * elliptical cross-section. Parallel-transport frames keep the trunk free of twist.
 */
export function tube(
  points: THREE.Vector3[],
  radii: number[],
  sides = 8,
  opts: { color?: THREE.ColorRepresentation; squash?: number; cap?: boolean } = {},
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const col = new THREE.Color(opts.color ?? 0xffffff);
  const squash = opts.squash ?? 1;
  const n = points.length;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(next, prev).normalize());
  }

  let normal = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tangents[0].dot(normal)) > 0.9) normal.set(0, 1, 0);
  normal.crossVectors(tangents[0], normal).normalize();

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tangents[i - 1], t);
      const len = axis.length();
      if (len > 1e-6) {
        normal.applyAxisAngle(axis.normalize(), Math.acos(THREE.MathUtils.clamp(tangents[i - 1].dot(t), -1, 1)));
      }
    }
    normal.sub(t.clone().multiplyScalar(normal.dot(t))).normalize();
    const binormal = new THREE.Vector3().crossVectors(t, normal).normalize();
    const ring: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const v = points[i]
        .clone()
        .addScaledVector(normal, Math.cos(a) * radii[i])
        .addScaledVector(binormal, Math.sin(a) * radii[i] * squash);
      ring.push(v);
    }
    rings.push(ring);
  }

  const push = (v: THREE.Vector3, c: THREE.Color) => {
    positions.push(v.x, v.y, v.z);
    colors.push(c.r, c.g, c.b);
  };
  const shade = (i: number) => col.clone().multiplyScalar(0.82 + 0.18 * (i / Math.max(1, n - 1)));

  for (let i = 0; i < n - 1; i++) {
    const c0 = shade(i);
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = rings[i][s];
      const b = rings[i][s2];
      const c = rings[i + 1][s2];
      const d = rings[i + 1][s];
      push(a, c0);
      push(b, c0);
      push(c, c0);
      push(a, c0);
      push(c, c0);
      push(d, c0);
    }
  }

  if (opts.cap !== false) {
    const tipTop = points[n - 1].clone().addScaledVector(tangents[n - 1], radii[n - 1] * 0.55);
    const tipBot = points[0].clone().addScaledVector(tangents[0], -radii[0] * 0.5);
    const cTop = shade(n - 1);
    const cBot = shade(0);
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      push(rings[n - 1][s], cTop);
      push(rings[n - 1][s2], cTop);
      push(tipTop, cTop);
      push(rings[0][s2], cBot);
      push(rings[0][s], cBot);
      push(tipBot, cBot);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A soft foliage clump: an icosphere blended with itself at a second, offset scale
 * so the silhouette is lobed and organic rather than a perfect ball. Smooth-shaded
 * with a vertical colour ramp; this is the building block of the broadleaf canopies.
 */
export function foliageClump(
  radius: number,
  detail: number,
  colors: { top: THREE.ColorRepresentation; mid: THREE.ColorRepresentation; under: THREE.ColorRepresentation },
  seed = 0,
  squash = 0.82,
): THREE.BufferGeometry {
  const rnd = mulberry32(seed * 7919 + 13);
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const lobes = [
    { a: rnd() * 6.28, b: rnd() * 6.28, f: 2.1 + rnd() * 0.8, amp: 0.11 },
    { a: rnd() * 6.28, b: rnd() * 6.28, f: 3.4 + rnd() * 1.1, amp: 0.07 },
    { a: rnd() * 6.28, b: rnd() * 6.28, f: 5.3 + rnd() * 1.4, amp: 0.035 },
  ];

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const d = p.clone().normalize();
    let bump = 0;
    for (const l of lobes) {
      bump += Math.sin(d.x * l.f + l.a) * Math.cos(d.y * l.f + l.b) * l.amp;
    }
    p.multiplyScalar(1 + bump);
    p.y *= squash;
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();

  const colorsArr = new Float32Array(pos.count * 3);
  const cTop = new THREE.Color(colors.top);
  const cMid = new THREE.Color(colors.mid);
  const cUnder = new THREE.Color(colors.under);
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;

  for (let i = 0; i < pos.count; i++) {
    // blend by height AND by how much the surface faces the sky
    const t = THREE.MathUtils.clamp(pos.getY(i) / (radius * squash) * 0.5 + 0.5, 0, 1);
    const up = THREE.MathUtils.clamp(nrm.getY(i) * 0.5 + 0.5, 0, 1);
    const c = cUnder.clone().lerp(cMid, t * 0.7 + up * 0.3).lerp(cTop, Math.max(0, t - 0.45) * 1.4);
    colorsArr[i * 3] = c.r;
    colorsArr[i * 3 + 1] = c.g;
    colorsArr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colorsArr, 3));
  return geo;
}

/** Closed, slightly asymmetric blob from an icosphere — used for rocks and cloud puffs. */
export function blob(
  radius: number,
  detail: number,
  color: THREE.ColorRepresentation,
  warp: (v: THREE.Vector3, i: number) => void = () => {},
): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    warp(v, i);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  paint(geo, color);
  return faceted(geo);
}

/**
 * A closed folded "umbrella pad" used for tree A canopies and tree C caps:
 * top ridge, wide mid ring, lower rim and a closed underside.
 */
export function foldedPad(
  radius: number,
  height: number,
  sides: number,
  colors: { top: THREE.ColorRepresentation; side: THREE.ColorRepresentation; under: THREE.ColorRepresentation },
  opts: { irregular?: number; rimDrop?: number; raise?: number } = {},
): THREE.BufferGeometry {
  const irregular = opts.irregular ?? 0.1;
  const rimDrop = opts.rimDrop ?? 0.08;
  const raise = opts.raise ?? 0.34;
  const positions: number[] = [];
  const cols: number[] = [];
  const cTop = new THREE.Color(colors.top);
  const cSide = new THREE.Color(colors.side);
  const cUnder = new THREE.Color(colors.under);

  const ringAt = (r: number, y: number, phase: number) => {
    const out: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + phase;
      const wobble = 1 + Math.sin(a * 3 + phase * 4) * irregular + Math.sin(a * 5 - phase) * irregular * 0.5;
      out.push(new THREE.Vector3(Math.cos(a) * r * wobble, y + Math.sin(a * 2 + phase) * height * 0.03, Math.sin(a) * r * wobble));
    }
    return out;
  };

  const topRing = ringAt(radius * 0.4, height * (0.72 + raise * 0.2), 0.2);
  const midRing = ringAt(radius, height * 0.36, 0);
  const rimRing = ringAt(radius * 0.9, -height * rimDrop, 0);
  const underRing = ringAt(radius * 0.42, -height * (rimDrop + 0.16), 0.1);
  const topTip = new THREE.Vector3(0, height * 0.98, 0);
  const underTip = new THREE.Vector3(0, -height * (rimDrop + 0.34), 0);

  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) cols.push(col.r, col.g, col.b);
  };

  for (let s = 0; s < sides; s++) {
    const s2 = (s + 1) % sides;
    tri(topTip, topRing[s2], topRing[s], cTop);
    tri(topRing[s], topRing[s2], midRing[s2], cTop);
    tri(topRing[s], midRing[s2], midRing[s], cTop);
    tri(midRing[s], midRing[s2], rimRing[s2], cSide);
    tri(midRing[s], rimRing[s2], rimRing[s], cSide);
    tri(rimRing[s], rimRing[s2], underRing[s2], cUnder);
    tri(rimRing[s], underRing[s2], underRing[s], cUnder);
    tri(underRing[s], underRing[s2], underTip, cUnder);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Folded feather blade with real thickness — closed volume, not a paper plane. */
export function featherBlade(
  length: number,
  width: number,
  thickness: number,
  colors: { top: THREE.ColorRepresentation; edge: THREE.ColorRepresentation; under: THREE.ColorRepresentation },
  droop = 0.25,
  steps = 4,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const cols: number[] = [];
  const cTop = new THREE.Color(colors.top);
  const cEdge = new THREE.Color(colors.edge);
  const cUnder = new THREE.Color(colors.under);

  const sample = (i: number) => {
    const t = i / steps;
    const w = width * Math.sin(Math.PI * Math.pow(t, 0.72)) * (1 - t * 0.25);
    const y = -droop * length * t * t;
    return { x: t * length, w: Math.max(0.001, w), y };
  };

  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) cols.push(col.r, col.g, col.b);
  };

  for (let i = 0; i < steps; i++) {
    const a = sample(i);
    const b = sample(i + 1);
    const ridgeA = new THREE.Vector3(a.x, a.y + thickness, 0);
    const ridgeB = new THREE.Vector3(b.x, b.y + thickness, 0);
    const la = new THREE.Vector3(a.x, a.y, -a.w);
    const lb = new THREE.Vector3(b.x, b.y, -b.w);
    const ra = new THREE.Vector3(a.x, a.y, a.w);
    const rb = new THREE.Vector3(b.x, b.y, b.w);
    const ua = new THREE.Vector3(a.x, a.y - thickness, 0);
    const ub = new THREE.Vector3(b.x, b.y - thickness, 0);
    push(ridgeA, la, lb, cTop);
    push(ridgeA, lb, ridgeB, cTop);
    push(ridgeA, ridgeB, rb, cTop);
    push(ridgeA, rb, ra, cTop);
    push(ua, lb, la, cUnder);
    push(ua, ub, lb, cUnder);
    push(ua, rb, ub, cUnder);
    push(ua, ra, rb, cUnder);
    push(la, lb, ub, cEdge);
    push(la, ub, ua, cEdge);
    push(ra, ub, rb, cEdge);
    push(ra, ua, ub, cEdge);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * One grass blade: a wide, folded leaf with a keel down the middle, tapering to a
 * soft point. The fold is what stops a lawn reading as scattered hairlines — a
 * flat ribbon disappears edge-on, a V-section catches light from both sides.
 */
/**
 * A single grass blade: a curved, tapering, V-folded leaf.
 *
 * The previous version built each segment as a flat V-triangle pair, which
 * produced hard straight edges and a saw-tooth silhouette — it read as paper
 * spikes rather than grass. This builds the blade as a swept ribbon instead:
 * the centre line curves forward and droops at the tip, the width tapers on a
 * smooth curve to a point, and the fold (keel) narrows with it, so the outline
 * is a tapered leaf with a soft bend.
 */
export function grassBlade(
  length: number,
  width: number,
  bend: number,
  color: THREE.ColorRepresentation,
  tint: number,
  steps = 4,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const cols: number[] = [];
  const c = new THREE.Color(color);
  // Subtle tonal spread only: wild per-blade hue changes make a lawn look like
  // scattered hair instead of ground cover.
  const cTip = c.clone().lerp(new THREE.Color(0xe2f3c0), 0.30 + tint * 0.14);
  const cBase = c.clone().multiplyScalar(0.74 + tint * 0.08);
  const cKeel = c.clone().multiplyScalar(1.1);

  interface Node {
    centre: THREE.Vector3;
    left: THREE.Vector3;
    right: THREE.Vector3;
    keel: THREE.Vector3;
    col: THREE.Color;
  }

  const nodes: Node[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // smooth forward arc; the tip also droops so the silhouette hooks over
    const arc = Math.sin(t * Math.PI * 0.5) * 0.55 + t * 0.45;
    const droop = Math.pow(t, 2.6) * 0.22;
    const centre = new THREE.Vector3(bend * arc * length, (t - droop * t) * length, bend * 0.2 * arc * length);
    // width: full low down, tapering to a point with a smooth ease
    const w = width * Math.pow(1 - t, 0.75);
    // keel: a real fold with volume that also vanishes at the tip
    const up = width * 0.62 * Math.pow(1 - t, 0.55) * Math.sin(Math.min(1, t * 2.4) * Math.PI * 0.42);
    nodes.push({
      centre,
      left: new THREE.Vector3(centre.x, centre.y, centre.z - w),
      right: new THREE.Vector3(centre.x, centre.y, centre.z + w),
      keel: new THREE.Vector3(centre.x, centre.y + up, centre.z),
      col: cBase.clone().lerp(cTip, Math.pow(t, 0.8)),
    });
  }

  const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, col: THREE.Color) => {
    positions.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    for (let k = 0; k < 3; k++) cols.push(col.r, col.g, col.b);
  };

  for (let i = 0; i < steps; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const mid = a.col.clone().lerp(b.col, 0.5);
    if (steps <= 2) {
      // far LOD: a plain quad per segment, no keel — halves the triangles and
      // is indistinguishable past ~30 BU
      tri(a.left, a.right, b.right, a.col);
      tri(a.left, b.right, b.left, mid);
      continue;
    }
    // left panel (base → keel), right panel (keel → base); the two share the
    // keel edge so the leaf folds along its spine
    tri(a.left, a.keel, b.keel, a.col);
    tri(a.left, b.keel, b.left, mid);
    tri(a.keel, a.right, b.right, a.col.clone().lerp(cKeel, 0.25));
    tri(a.keel, b.right, b.keel, mid.clone().lerp(cKeel, 0.2));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

export function translate(geo: THREE.BufferGeometry, x: number, y: number, z: number) {
  geo.translate(x, y, z);
  return geo;
}

export function rotY(geo: THREE.BufferGeometry, a: number) {
  geo.rotateY(a);
  return geo;
}

export function scaleGeo(geo: THREE.BufferGeometry, sx: number, sy = sx, sz = sx) {
  geo.scale(sx, sy, sz);
  return geo;
}

export { lerpV3 };
