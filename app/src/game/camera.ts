import * as THREE from 'three';
import { IslandField } from './world';
import { clamp01, damp, lerp } from '../lib/noise';

/**
 * Third-person orbit camera.
 * - free look that never snaps back when the mouse is released
 * - smooth follow, smooth zoom
 * - terrain-aware placement so it never sits inside a hill
 * - gentle occlusion fade on nearby vegetation is handled by material opacity in Game
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** orbit angle: the eye sits at focus + (sin(yaw), ·, cos(yaw)) * distance */
  yaw = 0;
  pitch = 0.3;
  private targetYaw = 0;
  private targetPitch = 0.3;
  distance = 8.4;
  targetDistance = 8.4;
  /** resting distance the wheel starts from after a settings change */
  private baseDistance = 8.4;
  private smoothPos = new THREE.Vector3();
  private lastFocus = new THREE.Vector3();
  private field: IslandField;
  private shake = 0;
  private initialised = false;
  private occlusionMax = Infinity;
  /** optional assist: turns the camera behind the player while moving. Off by default. */
  movementAssist = false;
  sensitivity = 1;
  invertY = false;

  constructor(field: IslandField, camera: THREE.PerspectiveCamera) {
    this.field = field;
    this.camera = camera;
  }

  addShake(v: number) {
    this.shake = Math.min(1, this.shake + v);
  }

  /** sprint affects both FOV and follow distance: this is what "feels fast" */
  private sprintFov = 0;
  /** 0..1, set by the engine from the player's sprint blend */
  sprintAmount = 0;
  private readonly baseFov = 52;

  handleLook(dx: number, _dy: number) {
    // horizontal only: the orbit pitch is fixed, so the mouse spins the view a
    // full 360° left/right and never tilts up or down
    const sens = 0.0026 * this.sensitivity;
    // view forward is -(sin yaw, cos yaw): decreasing yaw turns the view rightward,
    // which is what mouse-right must do
    this.targetYaw -= dx * sens;
  }

  handleZoom(wheel: number) {
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + wheel * 0.0055, 3.4, 13.5);
    this.baseDistance = this.targetDistance;
  }

  /** Resting follow distance from the settings panel. */
  setBaseDistance(d: number) {
    this.baseDistance = Number.isFinite(d) ? THREE.MathUtils.clamp(d, 3.4, 13.5) : this.baseDistance;
  }

  /** Applies the resting distance without fighting an in-progress wheel zoom. */
  applyBaseDistance() {
    this.targetDistance = this.baseDistance;
  }

  /** Instantly frame the player (spawn / after closing overlays). */
  snap(target: THREE.Vector3) {
    this.yaw = this.targetYaw;
    this.pitch = this.targetPitch;
    this.distance = this.targetDistance;
    const desired = new THREE.Vector3();
    this.computeDesired(target, desired);
    this.camera.position.copy(desired);
    this.smoothPos.copy(desired);
    this.camera.lookAt(target.clone().add(new THREE.Vector3(0, 1.5, 0)));
    this.initialised = true;
  }

  /** External framing override used by diagnostics/screenshots (never by gameplay input). */
  frame(yaw: number, pitch: number, distance: number) {
    this.targetYaw = this.yaw = yaw;
    this.targetPitch = this.pitch = pitch;
    this.targetDistance = this.distance = distance;
    this.initialised = false;
  }

  /** Occlusion clamp: never place the eye farther than `maxDist` from the focus. */
  pushIn(maxDist: number) {
    this.occlusionMax = Math.max(3.0, maxDist);
  }

  releasePush() {
    this.occlusionMax = Infinity;
  }

  private computeDesired(target: THREE.Vector3, out: THREE.Vector3) {
    const focus = target.clone().add(new THREE.Vector3(0, 0.92, 0));
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();
    out.copy(focus).addScaledVector(dir, this.distance);
    return { focus, dir };
  }

  update(dt: number, target: THREE.Vector3) {
    if (this.movementAssist) {
      // nudges the orbit behind the player's facing, only when explicitly enabled
      // (kept gentle so it never fights a manual look)
    }

    this.yaw = damp(this.yaw, this.targetYaw, 13, dt);
    this.pitch = damp(this.pitch, this.targetPitch, 13, dt);
    this.distance = damp(this.distance, this.targetDistance, 8, dt);

    // Sprint widens the lens and pulls the eye back a touch. Without a visible
    // change in framing, a 2.2x speed increase reads as "the ground scrolls",
    // not as the character running — the reported "感受不到冲刺".
    const wantFov = this.baseFov + this.sprintAmount * 11;
    this.sprintFov = damp(this.sprintFov, wantFov, 6, dt);
    if (Math.abs(this.camera.fov - this.sprintFov) > 0.01) {
      this.camera.fov = this.sprintFov;
      this.camera.updateProjectionMatrix();
    }
    const sprintPull = this.sprintAmount * 0.9;

    const desired = new THREE.Vector3();
    const { focus } = this.computeDesired(target, desired);
    this.lastFocus.copy(focus);
    // the extra follow distance rides on top of the occlusion-safe distance
    if (sprintPull > 0.001) {
      const dirOut = desired.clone().sub(focus).normalize();
      desired.copy(focus).addScaledVector(dirOut, this.distance + sprintPull);
    }

    // pull the camera in when the line of sight crosses terrain or a solid prop
    const step = 0.55;
    const rayDir = desired.clone().sub(focus).normalize();
    let allowed = Math.min(this.distance, this.occlusionMax);
    for (let d = 0.8; d <= this.distance; d += step) {
      const p = focus.clone().addScaledVector(rayDir, d);
      const ground = this.field.height(p.x, p.z);
      if (p.y < ground + 0.5) {
        allowed = Math.min(allowed, Math.max(1.9, d - 0.75));
        break;
      }
    }
    if (allowed < this.distance) {
      desired.copy(focus).addScaledVector(rayDir, allowed);
    }

    if (!this.initialised) {
      this.smoothPos.copy(desired);
      this.initialised = true;
    } else {
      // vertical is smoothed harder so hills don't bounce the frame
      const lambdaXZ = 12;
      const lambdaY = 7;
      this.smoothPos.x = damp(this.smoothPos.x, desired.x, lambdaXZ, dt);
      this.smoothPos.z = damp(this.smoothPos.z, desired.z, lambdaXZ, dt);
      this.smoothPos.y = damp(this.smoothPos.y, desired.y, lambdaY, dt);
    }

    // never dip under the terrain
    const groundHere = this.field.height(this.smoothPos.x, this.smoothPos.z);
    if (this.smoothPos.y < groundHere + 0.8) this.smoothPos.y = groundHere + 0.8;

    this.camera.position.copy(this.smoothPos);
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - dt * 2.6);
      const s = this.shake * 0.05;
      this.camera.position.x += Math.sin(performance.now() * 0.055) * s;
      this.camera.position.y += Math.cos(performance.now() * 0.07) * s;
    }
    const lookTarget = focus.clone().add(new THREE.Vector3(0, 0.24, 0));
    this.camera.lookAt(lookTarget);
  }

  /** camera-space yaw the player uses for movement, resolved from the current orbit */
  get movementYaw() {
    return this.yaw;
  }

  /** World-space focus point + current eye, for occlusion raycasts and HUD anchoring. */
  get focusPoint(): THREE.Vector3 {
    return this.lastFocus;
  }

  get eye(): THREE.Vector3 {
    return this.camera.position;
  }
}

export { clamp01, lerp };
