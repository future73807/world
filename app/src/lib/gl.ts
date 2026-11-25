import * as THREE from 'three';

/**
 * Hand-built triangle soup often ends up with some faces wound inward, which reads
 * as black facets under directional light. For closed-ish volumes we can fix this
 * deterministically: if a face normal points back toward the hull centre, flip it.
 *
 * The one helper still in use (for the far islets). The tree, rock, grass and
 * flower builders that used to share this file, and `game/flora.ts` with them,
 * are gone: every model is built in Blender now (see app/README.md).
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
  const edge = new THREE.Vector3();
  let flipped = 0;

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    d.fromBufferAttribute(pos, i + 2);
    nrm.subVectors(b, a).cross(edge.subVectors(d, a));
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
