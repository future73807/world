import * as THREE from 'three';
import { PAL } from './palette';
import { lerp, smoothstep } from '../lib/noise';

/**
 * Slime — modelled on the reference hydro-slime: a squat gel DOME sitting on a
 * flat base, two soft horn nubs on the crown, and two large oval eyes with a blue
 * ring and a pale glowing core. Built as a shared-vertex ring shell so normals
 * shade smoothly while the body squashes and stretches.
 */
export const SLIME_HEIGHT = 1.0;

interface RingSpec {
  y: number;
  radius: number;
  /** lateral offset of the ring centre (fraction of radius) — gives the forward lean */
  lean: number;
  zOffset: number;
}

/**
 * Catmull-Rom through the profile keys. Per-segment smoothstep (the obvious
 * approach) has a curvature jump at every key boundary; on a 42-ring shell
 * those jumps read as visible horizontal creases across the belly.
 */
function sampleKeys(keys: [number, number][], t: number): number {
  let k = 0;
  while (k < keys.length - 2 && t > keys[k + 1][0]) k++;
  const [u0, v0] = keys[k];
  const [u1, v1] = keys[k + 1];
  const vm1 = keys[Math.max(0, k - 1)][1];
  const v2 = keys[Math.min(keys.length - 1, k + 2)][1];
  const f = u1 === u0 ? 0 : (t - u0) / (u1 - u0);
  const f2 = f * f;
  const f3 = f2 * f;
  return Math.max(
    0,
    0.5 * (2 * v0 + (-vm1 + v1) * f + (2 * vm1 - 5 * v0 + 4 * v1 - v2) * f2 + (-vm1 + 3 * v0 - 3 * v1 + v2) * f3),
  );
}

let PROFILE_CACHE: RingSpec[] | null = null;
/** Cached: the profile is a pure constant, and the face code samples it per frame. */
function profileRings(): RingSpec[] {
  if (PROFILE_CACHE) return PROFILE_CACHE;
  // Dome profile: a true half-dome — wide belly through the low third, then a
  // firm taper so the crown is clearly narrower than the base. Read as
  // "small on top, big at the bottom" at a glance, not just a squat blob.
  // The crown deliberately flattens out early (0.86 → 0.5 by t=0.72): the gel
  // nubs sit on that shoulder, and a tall central dome would ride above them
  // and hide them from every camera angle.
  const keys: [number, number][] = [
    [0.0, 0.88],
    [0.12, 1.0],
    [0.35, 0.97],
    [0.55, 0.88],
    [0.72, 0.70],
    [0.86, 0.46],
    [0.95, 0.24],
    [1.0, 0.06],
  ];
  const rings: RingSpec[] = [];
  // 42 rings: the crown nubs are a vertical gaussian too, and 26 rings left
  // only one or two rows up top — the bump degenerated into a spike.
  const count = 42;
  const maxR = 0.82;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const r = sampleKeys(keys, t);
    const y = t * SLIME_HEIGHT;
    rings.push({
      y,
      radius: r * maxR,
      lean: 0.02 * smoothstep(0.1, 0.95, t),
      zOffset: 0,
    });
  }
  PROFILE_CACHE = rings;
  return rings;
}

/** Two gel nubs on the crown, defined as a displacement of the dome itself. */
const HORN_ANGLE = 0.62; // separation from the FRONT axis, radians
const HORN_SIGMA = 0.24;
const HORN_LIFT = 0.44; // extra height at the nub centre
const HORN_BULGE = 0.24; // radial swell at the nub centre
// The nub is centred on the upper crown (t≈0.78) where the dome is already
// narrow, so the lift clears the apex ring instead of sinking into it.
const HORN_T = 0.78;
const HORN_T_SIGMA = 0.135;

export class Slime {
  readonly root = new THREE.Group();
  private body: THREE.Mesh;
  private bodyGeo: THREE.BufferGeometry;
  private basePositions: Float32Array;
  private eyes: THREE.Group[] = [];
  private pupils: THREE.Mesh[] = [];
  private lids: THREE.Mesh[] = [];
  private core: THREE.Mesh;

  private blink = 0;
  private blinkTimer = 1.8;
  private squash = 0;
  private squashVel = 0;
  private time = 0;
  private squashTarget = 0;
  private lookAt = new THREE.Vector2();
  /**
   * Global multiplier on the contact shadow, set by the player from sun angle
   * and surface type — the blob is a soft approximation, so it is simply faded
   * out where a real shadow already exists, and kept at full strength airborne.
   */
  contactBase = 1;
  /** blob contact shadow under the slime, shrinks and fades with altitude */
  private contact: THREE.Mesh;
  private contactMat: THREE.MeshBasicMaterial;

  constructor() {
    this.root.name = 'Slime_Root';

    const built = this.buildBody();
    this.bodyGeo = built.geo;
    this.basePositions = built.base;

    // Translucent gel: the reference slime is see-through with a bright rim and an
    // inner glow. A real transmission pass sorts badly against itself, so the shell
    // is alpha-blended with fresnel-driven opacity — edges turn opaque, the middle
    // stays see-through, which is exactly how the reference reads.
    const bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0,
      transparent: true,
      opacity: 0.86,
      side: THREE.FrontSide,
      emissive: new THREE.Color(PAL.slimeDeep),
      emissiveIntensity: 0.22,
      envMapIntensity: 1.3,
      depthWrite: true,
    });
    bodyMat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = { value: new THREE.Color(PAL.slimeRim) };
      shader.uniforms.uRimPower = { value: 3.1 };
      shader.uniforms.uRimStrength = { value: 0.6 };
      shader.uniforms.uGlossColor = { value: new THREE.Color(0xffffff) };
      shader.uniforms.uGlossStrength = { value: 0.22 };
      shader.uniforms.uSparkStrength = { value: 0.3 };
      shader.uniforms.uHornColor = { value: new THREE.Color(0x9fe6ea) };
      shader.uniforms.uSparkleColor = { value: new THREE.Color(0xeafffb) };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uRimColor;
           uniform float uRimPower;
           uniform float uRimStrength;
           uniform vec3 uGlossColor;
           uniform float uGlossStrength;
           uniform vec3 uSparkleColor;
           uniform float uSparkStrength;`,
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
           vec3 viewDir = normalize(vViewPosition);
           vec3 nrmDir = normalize(vNormal);
           float facing = clamp(dot(nrmDir, viewDir), 0.0, 1.0);
           // strong rim: the gel turns bright and opaque at its edge
           float rim = pow(1.0 - facing, uRimPower);
           gl_FragColor.rgb += uRimColor * rim * uRimStrength;
           // wet-skin sheen confined to the crown so the face stays readable
           float gloss = pow(max(dot(reflect(-viewDir, nrmDir), normalize(vec3(0.0, 1.0, 0.0))), 0.0), 26.0);
           gl_FragColor.rgb += uGlossColor * gloss * uGlossStrength;
           // tight sparkle dots, like the glints on the reference gel
           float sparkle = pow(max(dot(reflect(-viewDir, nrmDir), normalize(vec3(-0.5, 0.75, 0.4))), 0.0), 90.0);
           gl_FragColor.rgb += uSparkleColor * sparkle * uSparkStrength;
           // edges more opaque, centre see-through: gel read-through
           gl_FragColor.a = clamp(0.55 + rim * 0.75 + facing * 0.32, 0.0, 1.0);`,
        );
    };
    this.body = new THREE.Mesh(this.bodyGeo, bodyMat);
    this.body.name = 'Slime_Body';
    this.body.castShadow = true;
    // a smooth organic shell self-shadowing against a moving deform target only
    // produces banding; the character keeps its cast shadow, but not received acne
    this.body.receiveShadow = false;
    this.root.add(this.body);
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nobody')) this.body.visible = false;

    // inner core glow — a soft diffuse heart, not a visible ball
    const coreGeo = new THREE.IcosahedronGeometry(0.3, 2);
    const coreMat = new THREE.MeshBasicMaterial({
      color: PAL.slimeCore,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(coreGeo, coreMat);
    this.core.name = 'Slime_Core';
    this.core.position.set(0, 0.5, 0.05);
    this.core.renderOrder = -1;
    this.root.add(this.core);


    for (const side of [-1, 1]) {
      const eye = this.buildEye(side);
      this.root.add(eye);
    }

    // Contact shadow: a soft blob on the ground. It is what sells "the slime is
    // in the air" — without a shadow, a lifted body still reads as glued to the
    // ground because the eye has no cue for the gap.
    const contactGeo = new THREE.CircleGeometry(0.9, 24);
    contactGeo.rotateX(-Math.PI / 2);
    this.contactMat = new THREE.MeshBasicMaterial({
      color: 0x1b3a33,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      fog: false,
    });
    this.contact = new THREE.Mesh(contactGeo, this.contactMat);
    this.contact.name = 'Slime_Contact';
    this.contact.renderOrder = 3;
    this.root.add(this.contact);

  }

  private buildBody(): {
    geo: THREE.BufferGeometry;
    base: Float32Array;
    rings: number;
    sides: number;
    profile: RingSpec[];
  } {
    const profile = profileRings();
    const rings = profile.length;
    // A denser ring mesh than the body needs on its own: the crown nubs are a
    // smooth gaussian displacement, so they need enough vertices to resolve as
    // a rounded bump instead of a single spike.
    const sides = 44;
    const positions: number[] = [];
    const colors: number[] = [];
    const bodyCol = new THREE.Color(0x4ec6d4);
    const deepCol = new THREE.Color(0x10788f);
    const bellyCol = new THREE.Color(0xdcf9f4);
    const rimCol = new THREE.Color(PAL.slimeRim);

    // Gel gradient from the reference: pale luminous under-belly, saturated teal
    // through the middle, clearly deeper crown — small on top reads darker.
    const hornCol = new THREE.Color(0x0a5f75);
    const colorAt = (t: number) => {
      const c = bellyCol.clone().lerp(bodyCol, smoothstep(0.02, 0.3, t));
      c.lerp(deepCol, smoothstep(0.4, 0.94, t));
      c.lerp(rimCol, Math.max(0, smoothstep(0.86, 1, t)) * 0.08);
      return c;
    };
    /** Same gradient, tinted deeper where the nubs are denser gel. */
    const colorAtHorn = (t: number, horn: number) => colorAt(t).lerp(hornCol, horn * 0.6);

    const ringVerts: THREE.Vector3[][] = [];
    /** per-vertex nub weight, so the vertex COLOR can darken with the shape */
    const hornWeight: number[][] = [];
    for (let i = 0; i < rings; i++) {
      const spec = profile[i];
      const t = i / (rings - 1);
      const row: THREE.Vector3[] = [];
      const wRow: number[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        let x = Math.cos(a) * spec.radius;
        let z = Math.sin(a) * spec.radius + spec.zOffset;
        let y = spec.y;
        let horn = 0;
        // Gel nubs: a smooth displacement of the CROWN SURFACE itself, not a
        // separate ball glued on. Because the vertices belong to the shared
        // dome shell, the nubs shade continuously with the body, follow every
        // squash/ripple, and can never show a seam or read as paper geometry.
        // The vertical window is a BAND that fades out before the apex: lifting
        // vertices that share the final ring would push them above the single
        // apex vertex and fold the crown into an inverted cone.
        for (const side of [-1, 1]) {
          // Ring angle convention is x = cos(a), z = sin(a). The face is on
          // local -Z, which is a = -π/2 — NOT π. Using π put the nubs on the
          // slime's left and right flanks (the "长错地方了" report); they must
          // straddle the front axis so they read as horns above the eyes.
          const ha = -Math.PI / 2 + side * HORN_ANGLE;
          let da = a - ha;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          // A 2D gaussian in (angle, height): the nub peaks on the upper
          // shoulder, and grows to zero before the apex ring so the tip's
          // single vertex stays the topmost point.
          const dt = (t - HORN_T) / HORN_T_SIGMA;
          const band = Math.exp(-0.5 * dt * dt) * (1 - smoothstep(0.93, 1.0, t));
          if (band <= 0.002) continue;
          const ang = Math.exp(-(da * da) / (2 * HORN_SIGMA * HORN_SIGMA));
          const k = ang * band;
          horn = Math.max(horn, k);
          y += HORN_LIFT * k;
          // swell outward so the nub has volume, not just a spike
          const swell = 1 + (HORN_BULGE / Math.max(0.18, spec.radius)) * k;
          x *= swell;
          z *= swell;
        }
        row.push(new THREE.Vector3(x + spec.lean, y, z));
        wRow.push(horn);
      }
      ringVerts.push(row);
      hornWeight.push(wRow);
    }

    const pushVert = (v: THREE.Vector3, c: THREE.Color) => {
      positions.push(v.x, v.y, v.z);
      colors.push(c.r, c.g, c.b);
    };

    // One vertex per (ring, side). Sharing the shell vertices makes
    // computeVertexNormals produce smooth continuous shading — a non-indexed
    // triangle soup instead split the body into visible horizontal bands.
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      for (let s = 0; s < sides; s++) {
        pushVert(ringVerts[i][s], colorAtHorn(t, hornWeight[i][s]));
      }
    }

    const index: number[] = [];
    for (let i = 0; i < rings - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        const a = i * sides + s;
        const b = i * sides + s2;
        const c = (i + 1) * sides + s2;
        const d = (i + 1) * sides + s;
        // alternate the diagonal for a designed triangulation; winding faces outward
        if ((i + s) % 2 === 0) {
          index.push(a, d, c, a, c, b);
        } else {
          index.push(a, d, b, b, d, c);
        }
      }
    }

    // apex cap. It sits slightly BELOW the highest nub: from a normal
    // third-person angle the two gel nubs must be the crown's silhouette, or a
    // central dome hides them and the head reads as a plain blob.
    const apexY = profile[rings - 1].y - 0.015;
    const apexIdx = positions.length / 3;
    pushVert(new THREE.Vector3(profile[rings - 1].lean, apexY, profile[rings - 1].zOffset), colorAt(1));
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const top = (rings - 1) * sides;
      index.push(top + s2, top + s, apexIdx);
    }
    // base cap
    const baseIdx = positions.length / 3;
    pushVert(new THREE.Vector3(profile[0].lean, profile[0].y, profile[0].zOffset), colorAt(0));
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      index.push(s, s2, baseIdx);
    }

    // (the crown nubs are part of the shell above — no separate droplet meshes,
    // which is what made them read as paper cut-outs sitting on the dome)

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();

    return {
      geo,
      base: Float32Array.from(positions),
      rings,
      sides,
      profile,
    };
  }

  /** Body radius at a given world height, so face parts sit exactly on the surface. */
  private surfaceRadiusAt(y: number): number {
    const t = THREE.MathUtils.clamp(y / SLIME_HEIGHT, 0, 1);
    const profile = profileRings();
    const idx = t * (profile.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(profile.length - 1, i0 + 1);
    const f = idx - i0;
    return lerp(profile[i0].radius, profile[i1].radius, f);
  }
  /**
   * The reference slime's eyes are GLOWING WHITE VERTICAL OVALS set into the gel —
   * not dark beads. Each eye is a flattened lens that hugs the surface, with a
   * faint darker halo so it stays readable against the bright rim.
   */
  private buildEye(side: number): THREE.Group {
    const g = new THREE.Group();
    g.name = side < 0 ? 'Slime_Eye_L' : 'Slime_Eye_R';
    // Face lives on the local -Z front of the gel. The lens sits just OUTSIDE the
    // shell: the body is alpha-blended over opaque geometry, so an eye left inside
    // gets tinted dull cyan instead of glowing.
    const angle = side * 0.38;
    const y = SLIME_HEIGHT * 0.5;
    const r = this.surfaceRadiusAt(y) + 0.02;
    const x = Math.sin(angle) * r;
    const z = -Math.cos(angle) * r;
    g.position.set(x, y, z);
    // orient the group so its local +z is the OUTWARD surface normal at this spot;
    // lookAt flipped it inward and sank the lens inside the gel shell
    g.rotation.y = Math.PI - angle;

    // blue outline disc behind the lens: the reference eye is ringed in blue
    const ringGeo = new THREE.SphereGeometry(0.185, 20, 16);
    ringGeo.scale(0.52, 1.0, 0.36);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x2f9fd8 }),
    );
    ring.position.z = -0.014;
    g.add(ring);

    // glowing pale core inside the ring — warm white-yellow, not pure white
    const geo = new THREE.SphereGeometry(0.148, 20, 16);
    geo.scale(0.47, 1.0, 0.38);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.1) });
    const eyeMesh = new THREE.Mesh(geo, mat);
    eyeMesh.name = 'eye';
    eyeMesh.position.z = 0.03;
    g.add(eyeMesh);

    // soft bloom behind everything so the eye reads as glowing through the gel
    const haloGeo = new THREE.SphereGeometry(0.17, 20, 16);
    haloGeo.scale(0.55, 1.0, 0.36);
    const halo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({ color: 0x9af1ff, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    halo.position.z = -0.022;
    g.add(halo);

    // blink lid: body-coloured shell that slides down over the whole eye
    const lid = this.buildLid();
    g.add(lid);
    this.lids.push(lid);

    this.eyes.push(g);
    return g;
  }

  private buildLid(): THREE.Mesh {
    const lidGeo = new THREE.SphereGeometry(0.185, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const lidMat = new THREE.MeshStandardMaterial({
      color: 0x5fd2d8,
      roughness: 0.3,
      transparent: true,
      opacity: 0.95,
    });
    const lid = new THREE.Mesh(lidGeo, lidMat);
    lid.scale.set(1, 1.05, 0.55);
    lid.position.y = 0.05;
    lid.visible = false;
    return lid;
  }

  /** Squash/stretch driven by locomotion; values in [-1,1]. */
  setSquash(v: number) {
    this.squashTarget = THREE.MathUtils.clamp(v, -1, 1);
  }

  setLook(dirX: number, dirZ: number) {
    this.lookAt.set(dirX, dirZ);
  }

  blinkNow() {
    this.blinkTimer = 0;
  }

  update(
    dt: number,
    speedRatio: number,
    groundDelta?: (wx: number, wz: number) => number,
    yaw = 0,
    px = 0,
    pz = 0,
    /**
     * Height of the body above the ground. Ground conformance is scaled by this:
     * the base skirt hugs the terrain while walking, but the moment the slime
     * jumps the whole shell must travel UP with it. Previously the skirt kept
     * pulling its bottom vertices back down to the terrain while airborne, which
     * left the body sitting flush on the ground for the entire jump.
     */
    airHeight = 0,
  ) {
    this.time += dt;

    // spring-driven squash & stretch feels biological rather than linear
    const k = 205;
    const damp = 14;
    const accel = (this.squashTarget - this.squash) * k - this.squashVel * damp;
    this.squashVel += accel * dt;
    this.squash += this.squashVel * dt;

    const breathe = Math.sin(this.time * 2.1) * 0.008 + Math.sin(this.time * 3.3 + 1.2) * 0.004;
    const sq = this.squash * 0.24 + breathe;
    const sy = 1 - sq * 0.85;
    const sxz = 1 + sq * 0.55;

    // deform the shell directly so the face rides the surface
    const pos = this.bodyGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.basePositions;
    const h = SLIME_HEIGHT;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    // 0 while grounded → 1 once clear of the ground. Ramped so a 10 cm step
    // still conforms, while any real jump releases the skirt completely.
    const air = THREE.MathUtils.clamp(airHeight / 0.55, 0, 1);
    const groundBlend = 1 - air;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = base[i];
      const by = base[i + 1];
      const bz = base[i + 2];
      const t = THREE.MathUtils.clamp(by / h, 0, 1);
      // squash concentrates near the base, stretch near the top
      const weight = lerp(0.55, 1.0, t);
      arr[i] = bx * (1 + (sxz - 1) * weight);
      arr[i + 2] = bz * (1 + (sxz - 1) * weight);
      arr[i + 1] = by * (1 + (sy - 1) * weight) + sq * 0.06 * (1 - t) * 0.0;
      // base skirt hugs the terrain: bottom vertices ride the ground height at
      // their own world position, so slopes never clip through the belly — the
      // body itself stays perfectly upright. Airborne, the skirt lets go.
      if (groundDelta && t < 0.18 && groundBlend > 0.001) {
        const wx = px + bx * cosY + bz * sinY;
        const wz = pz - bx * sinY + bz * cosY;
        const delta = THREE.MathUtils.clamp(groundDelta(wx, wz), -0.85, 0.85);
        arr[i + 1] += delta * (1 - t / 0.18) * groundBlend;
      }
      // jelly wobble: travelling ripple up the body while moving
      const ripple = Math.sin(by * 3.4 - this.time * 6.2) * 0.012 * speedRatio * (1 - t * 0.5);
      arr[i] += bx * ripple;
      arr[i + 2] += bz * ripple;
    }
    pos.needsUpdate = true;
    this.bodyGeo.computeVertexNormals();

    // face rides the deformed surface: eyes sit in the eye band, just above the
    // belly, not wrapped over the crown
    const faceY = 0.5 * sy;
    const faceScale = 1 + (sxz - 1) * 0.85;
    for (let i = 0; i < this.eyes.length; i++) {
      const side = i === 0 ? -1 : 1;
      const angle = side * 0.38;
      const r = this.surfaceRadiusAt(faceY) * faceScale + 0.02;
      const eye = this.eyes[i];
      eye.position.set(Math.sin(angle) * r, faceY, -Math.cos(angle) * r);
      // eye tracks the look direction a little
      eye.position.x += this.lookAt.x * 0.03;
    }
    this.core.position.y = 0.52 * sy;
    this.core.scale.setScalar(1 + Math.sin(this.time * 2.4) * 0.05);

    // contact shadow: stays on the ground plane (the root lifts with the body, so
    // it is pulled back down by the current altitude), shrinking and fading with
    // height. A slime in the air with no shadow under it reads as floating.
    this.contact.position.y = -airHeight + 0.035;
    const spread = 1 - Math.min(0.62, air * 0.62);
    const squashShadow = 1 + (sxz - 1) * 0.5;
    this.contact.scale.set(spread * squashShadow, 1, spread * squashShadow);
    this.contactMat.opacity = (0.26 - air * 0.16) * (1 - air * 0.35) * this.contactBase;

    // blinking: the lid shell only appears for the short moment the eye is closing.
    // Keeping it visible at rest hid the eye entirely behind a body-coloured dome.
    this.blinkTimer += dt;
    const cycle = 2.6 + Math.sin(this.time * 0.7) * 0.9;
    if (this.blinkTimer > cycle) {
      this.blinkTimer = 0;
      this.blink = 1;
    }
    if (this.blink > 0) {
      this.blink = Math.max(0, this.blink - dt * 9);
      const open = 1 - Math.sin(this.blink * Math.PI);
      const lidOn = open < 0.55;
      for (const lid of this.lids) {
        lid.visible = lidOn;
        lid.position.y = lerp(0.06, -0.012, 1 - open);
      }
      for (const eye of this.eyes) {
        // squash the eye group vertically instead of hiding it
        eye.scale.y = Math.max(0.12, open * open);
      }
    } else {
      for (const lid of this.lids) lid.visible = false;
      for (const eye of this.eyes) eye.scale.y = 1;
    }

    // pupil micro-drift keeps the face alive when idle
    for (let i = 0; i < this.pupils.length; i++) {
      const p = this.pupils[i];
      p.position.x = (i === 0 ? -1 : 1) * 0.018 + Math.sin(this.time * 0.9 + i * 2) * 0.008;
      p.position.y = 0.026 + Math.cos(this.time * 1.3 + i) * 0.006;
    }
  }
}
