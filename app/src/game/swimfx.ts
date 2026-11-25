import * as THREE from 'three';
import { SEA } from './world';

/**
 * What the water does around the slime: a ring where it breaks the surface,
 * ripples that spread out while it swims, and the trail of bubbles it leaves
 * under water. Everything lives at sea level and fades — nothing here is solid.
 */

const RING_INNER = 0.9;
const RINGS = 14;
const BUBBLES = 90;

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  from: number;
  to: number;
}

function bubbleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  // a thin bright rim, a clear middle and one highlight: a bubble, not a dot
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(235,250,255,0.22)';
  g.beginPath();
  g.arc(32, 32, 22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.ellipse(23, 21, 6, 4.2, -0.6, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SwimFx {
  readonly group = new THREE.Group();
  private rings: Ring[] = [];
  private next = 0;
  private rippleTimer = 0;
  private bubbleTimer = 0;

  private bubblePos = new Float32Array(BUBBLES * 3);
  private bubbleVel = new Float32Array(BUBBLES * 3);
  private bubbleLife = new Float32Array(BUBBLES);
  private points: THREE.Points;

  constructor() {
    this.group.name = 'Swim_Fx';
    const geo = new THREE.RingGeometry(RING_INNER, 1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.rings.push({ mesh, t: 0, dur: 1, from: 0, to: 1 });
    }

    const bgeo = new THREE.BufferGeometry();
    this.bubblePos.fill(-999);
    bgeo.setAttribute('position', new THREE.BufferAttribute(this.bubblePos, 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -4, 0), 400);
    const bmat = new THREE.PointsMaterial({
      map: bubbleTexture(),
      size: 0.2,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    });
    this.points = new THREE.Points(bgeo, bmat);
    this.points.renderOrder = 4;
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /** A ring spreads out from (x, z) on the surface. */
  private ripple(x: number, z: number, from: number, to: number, dur: number, delay = 0) {
    const r = this.rings[this.next];
    this.next = (this.next + 1) % this.rings.length;
    r.t = -delay;
    r.dur = dur;
    r.from = from;
    r.to = to;
    r.mesh.position.set(x, SEA + 0.04, z);
    r.mesh.scale.setScalar(from);
    r.mesh.visible = false;
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
  }

  private bubble(x: number, y: number, z: number) {
    for (let i = 0; i < BUBBLES; i++) {
      if (this.bubbleLife[i] > 0) continue;
      const a = Math.random() * Math.PI * 2;
      this.bubblePos[i * 3] = x + Math.cos(a) * 0.25;
      this.bubblePos[i * 3 + 1] = y + 0.2 + Math.random() * 0.3;
      this.bubblePos[i * 3 + 2] = z + Math.sin(a) * 0.25;
      this.bubbleVel[i * 3] = (Math.random() - 0.5) * 0.5;
      this.bubbleVel[i * 3 + 1] = 1.1 + Math.random() * 0.9;
      this.bubbleVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      this.bubbleLife[i] = 1;
      return;
    }
  }

  /**
   * @param p     the slime's position
   * @param state `splash` (1 when it just broke the surface), `inWater`, `held` (diving),
   *              `speed` (BU/s) and `time`
   */
  update(dt: number, p: THREE.Vector3, state: { splash: number; inWater: boolean; held: boolean; speed: number }, time: number) {
    for (const r of this.rings) {
      r.t += dt;
      if (r.t < 0) continue;
      const k = r.t / r.dur;
      if (k >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.mesh.visible = true;
      const e = 1 - Math.pow(1 - k, 2.4);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * (1 - k) * 0.5;
    }

    if (state.inWater) {
      // breaking the surface: a wide ring, then a second one a beat later
      if (state.splash > 0.95) {
        this.ripple(p.x, p.z, 0.7, 4.4, 1.5);
        this.ripple(p.x, p.z, 0.5, 2.6, 1.2, 0.18);
      }
      // swimming: ripples keep spreading from under the body
      this.rippleTimer -= dt;
      if (this.rippleTimer <= 0 && p.y > -1.6) {
        this.rippleTimer = 1.1 - Math.min(0.6, state.speed * 0.14);
        this.ripple(p.x, p.z, 0.42, 1.3 + state.speed * 0.16, 1.3);
      }
      // under water: a trail of bubbles rising to the surface
      if (p.y < -0.9) {
        this.bubbleTimer -= dt;
        if (this.bubbleTimer <= 0) {
          this.bubbleTimer = state.held ? 0.08 : 0.2;
          this.bubble(p.x, p.y, p.z);
        }
      }
    }

    let moved = false;
    for (let i = 0; i < BUBBLES; i++) {
      if (this.bubbleLife[i] <= 0) continue;
      const o = i * 3;
      this.bubblePos[o] += (this.bubbleVel[o] + Math.sin(time * 3 + i) * 0.25) * dt;
      this.bubblePos[o + 1] += this.bubbleVel[o + 1] * dt;
      this.bubblePos[o + 2] += (this.bubbleVel[o + 2] + Math.cos(time * 2.6 + i * 1.7) * 0.25) * dt;
      if (this.bubblePos[o + 1] >= SEA - 0.02) {
        // reached the surface: gone
        this.bubbleLife[i] = 0;
        this.bubblePos[o + 1] = -999;
      }
      moved = true;
    }
    if (moved) (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    for (const r of this.rings) {
      (r.mesh.material as THREE.Material).dispose();
    }
    this.rings[0].mesh.geometry.dispose();
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).map?.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
