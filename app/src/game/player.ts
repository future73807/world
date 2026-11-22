import * as THREE from 'three';
import { IslandField } from '../game/world';
import { clamp01, damp, lerp, wrapAngle } from '../lib/noise';
import { Slime, SLIME_HEIGHT } from './slime';
import { Intent } from './input';

/** Solid props the slime cannot walk through (trees, boulders). */
export interface Collider {
  x: number;
  z: number;
  r: number;
  top: number;
}

export type LocomotionState = 'idle' | 'start' | 'move' | 'stop' | 'turn' | 'prepare' | 'rise' | 'apex' | 'fall' | 'land';

/** dash: a short surge bought with stamina by clicking the bar */
const DASH_TIME = 0.34;
const DASH_COST = 0.18;

export class Player {
  readonly group = new THREE.Group();
  readonly slime: Slime;
  private field: IslandField;
  /** visual root offset from the logical foot point */
  private visual = new THREE.Group();

  pos = new THREE.Vector3(0, 0, 0);
  vel = new THREE.Vector3();
  /**
   * The slime's face is modelled on its local -Z. Facing world direction (dx,dz)
   * therefore requires yaw = atan2(-dx, -dz). The opening pose faces the camera so
   * the character reads immediately; pressing W turns it away naturally.
   */
  yaw = Math.PI;
  targetYaw = Math.PI;
  verticalVel = 0;
  grounded = true;
  private coyote = 0;
  private jumpBuffer = 0;
  private startTimer = 0;
  private landTimer = 0;
  private landImpact = 0;
  private speedSmoothed = 0;
  private strafeLean = 0;
  private sprintBlend = 0;
  /** 0..1 public read for the camera's speed feedback */
  get sprintAmount() {
    return this.sprintBlend;
  }
  /** stamina 0–1: drains while sprinting, refills after a breather */
  stamina = 1;
  private staminaCooldown = 0;
  /** a short burst left over from a dash click, in seconds */
  private dashTime = 0;
  private dashCooldown = 0;
  private stepPhase = 0;
  private idleTimer = 0;

  /** Click the stamina bar: a short forward surge costing a fixed slice. */
  dash(): boolean {
    if (this.dashCooldown > 0 || this.dashTime > 0) return false;
    if (this.stamina < DASH_COST) return false;
    this.stamina -= DASH_COST;
    this.staminaCooldown = 0.9;
    this.dashTime = DASH_TIME;
    return true;
  }

  state: LocomotionState = 'idle';
  speed = 0;
  /** solid obstacles, assigned by the engine (it owns the blocker list) */
  colliders: Collider[] = [];
  /** current walkable-world radius; the engine widens it as regions are wished in */
  boundaryRadius = 47.5;

  readonly walkSpeed = 3.15;
  readonly sprintSpeed = 7.0;
  private readonly accel = 17;
  private readonly decel = 20;
  private readonly turnRate = 11.5;
  private readonly gravity = 22;
  private readonly jumpVel = 6.1;

  constructor(field: IslandField, spawn: THREE.Vector3) {
    this.field = field;
    this.slime = new Slime();
    this.visual.add(this.slime.root);
    this.group.add(this.visual);
    this.group.name = 'Player';
    this.pos.copy(spawn);
    this.pos.y = field.height(spawn.x, spawn.z);
    this.group.position.copy(this.pos);
    this.yaw = Math.PI;
    this.targetYaw = Math.PI;
  }

  get headY() {
    return this.pos.y + SLIME_HEIGHT;
  }

  private turnTowards(target: number, dt: number, rate = this.turnRate) {
    const diff = wrapAngle(target - this.yaw);
    this.yaw += diff * clamp01(1 - Math.exp(-rate * dt));
    return diff;
  }

  update(dt: number, intent: Intent, cameraYaw: number, frozen: boolean) {
    const moveLen = Math.min(1, Math.hypot(intent.moveX, intent.moveZ));

    if (frozen) {
      this.slime.setSquash(0);
      this.slime.update(dt, 0);
      this.visual.position.y = 0;
      return;
    }

    // camera-relative desired direction
    let desiredX = 0;
    let desiredZ = 0;
    if (moveLen > 0.06) {
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      // camera sits at focus + (sin,cos)*d, so its view forward is -(sin,cos) and
      // its right is (cos,-sin); W drives along forward, D along right
      desiredX = intent.moveZ * sin + intent.moveX * cos;
      desiredZ = intent.moveZ * cos - intent.moveX * sin;
      const len = Math.hypot(desiredX, desiredZ) || 1;
      desiredX /= len;
      desiredZ /= len;
    }

    // stamina: sprinting drains it, running dry drops you back to a walk;
    // regeneration starts after a short breather and refills in ~4s
    const sprintWanted = intent.sprint && moveLen > 0.4 && this.stamina > 0.02;
    if (sprintWanted) {
      this.stamina = Math.max(0, this.stamina - dt / 5.2);
      this.staminaCooldown = 0.9;
    } else {
      this.staminaCooldown = Math.max(0, this.staminaCooldown - dt);
      if (this.staminaCooldown <= 0) this.stamina = Math.min(1, this.stamina + dt / 4);
    }

    // ---- dash ----
    // A click on the stamina bar spends a slice of it on a short forward surge:
    // a fixed impulse in the direction the slime is facing, with its own decay.
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.dashTime > 0) {
      this.dashTime = Math.max(0, this.dashTime - dt);
      const dx = -Math.sin(this.yaw);
      const dz = -Math.cos(this.yaw);
      const ease = this.dashTime / DASH_TIME;
      const dashSpeed = this.sprintSpeed * 2.2 * (0.35 + ease * 0.65);
      this.vel.x = dx * dashSpeed;
      this.vel.z = dz * dashSpeed;
      this.slime.setSquash(-0.35);
      if (this.dashTime === 0) this.dashCooldown = 0.45;
    }

    this.sprintBlend = damp(this.sprintBlend, sprintWanted || this.dashTime > 0 ? 1 : 0, 9, dt);
    const maxSpeed = lerp(this.walkSpeed, this.sprintSpeed, this.sprintBlend);

    // accelerate toward the desired planar velocity (skipped during a dash, which
    // owns the velocity outright)
    if (this.dashTime <= 0) {
      const targetVX = desiredX * maxSpeed * moveLen;
      const targetVZ = desiredZ * maxSpeed * moveLen;
      const rate = moveLen > 0.06 ? this.accel : this.decel;
      this.vel.x = damp(this.vel.x, targetVX, rate, dt);
      this.vel.z = damp(this.vel.z, targetVZ, rate, dt);
    }

    // face movement direction (not instantly — turning feedback is visible).
    // Rotating the camera must NOT spin the character: the slime keeps its
    // facing while idle, and only turns when it actually walks somewhere.
    const moving = moveLen > 0.06;
    if (moving) {
      this.idleTimer = 0;
      this.targetYaw = Math.atan2(-desiredX, -desiredZ);
      this.turnTowards(this.targetYaw, dt);
    }

    // planar integration
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // keep the player inside the known world (the mist wall is a soft physical
    // boundary). The radius GROWS when a wished island extends the frontier,
    // otherwise the clamp would strand the character on the birth island —
    // "过不去" was exactly this fixed constant.
    const maxR = this.boundaryRadius;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > maxR) {
      this.pos.x = (this.pos.x / r) * maxR;
      this.pos.z = (this.pos.z / r) * maxR;
      this.vel.x *= 0.2;
      this.vel.z *= 0.2;
    }

    // walkable ground: prevent walking into the sea
    const h = this.field.height(this.pos.x, this.pos.z);
    if (h < 0.28) {
      this.pos.x = prevX;
      this.pos.z = prevZ;
      this.vel.x *= 0.1;
      this.vel.z *= 0.1;
    }

    // solid props: circle-vs-circle push-out, then strip the velocity component
    // driving into the obstacle, so the slime slides along trunks and boulders
    const slideRadius = 0.52;
    for (const b of this.colliders) {
      if (b.top < this.pos.y + 0.35) continue; // low enough to walk over
      const dx = this.pos.x - b.x;
      const dz = this.pos.z - b.z;
      const rr = b.r + slideRadius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      this.pos.x += nx * (rr - d);
      this.pos.z += nz * (rr - d);
      const into = this.vel.x * nx + this.vel.z * nz;
      if (into < 0) {
        this.vel.x -= into * nx;
        this.vel.z -= into * nz;
      }
    }

    const groundNow = this.field.height(this.pos.x, this.pos.z);

    // jump with coyote time + input buffering
    if (intent.jump) this.jumpBuffer = 0.16;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.verticalVel = this.jumpVel;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.slime.setSquash(-0.7);
      this.state = 'prepare';
    }

    if (!this.grounded) {
      this.verticalVel -= this.gravity * dt;
      this.pos.y += this.verticalVel * dt;
      if (this.pos.y <= groundNow) {
        const impact = Math.min(1, Math.abs(this.verticalVel) / 9);
        this.pos.y = groundNow;
        this.verticalVel = 0;
        this.grounded = true;
        this.landImpact = impact;
        this.landTimer = 0.26;
        this.slime.setSquash(impact * 1.1);
        this.state = 'land';
      }
    } else {
      // stick to the slope, with a small smoothing so steps don't jitter
      this.pos.y = damp(this.pos.y, groundNow, 22, dt);
      if (Math.abs(this.pos.y - groundNow) < 0.02) this.pos.y = groundNow;
    }

    // ---- animation state machine ----
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.speedSmoothed = damp(this.speedSmoothed, this.speed, 12, dt);
    const speedRatio = clamp01(this.speedSmoothed / this.walkSpeed);

    if (!this.grounded) {
      if (this.verticalVel > 1.5) this.state = this.verticalVel > 4.2 ? 'rise' : 'apex';
      else if (this.verticalVel > -1.2) this.state = 'apex';
      else this.state = 'fall';
      if (this.state === 'apex') this.slime.setSquash(-0.25);
      else if (this.state === 'fall') this.slime.setSquash(0.16);
    } else if (this.landTimer > 0) {
      this.landTimer -= dt;
      this.state = 'land';
    } else if (speedRatio > 0.12) {
      if (this.startTimer <= 0 && this.state !== 'move') {
        this.startTimer = 0.14;
        this.slime.setSquash(-0.42);
      }
      if (this.startTimer > 0) {
        this.startTimer -= dt;
        this.state = 'start';
      } else {
        this.state = 'move';
        this.slime.setSquash(Math.sin(this.stepPhase * Math.PI) * 0.18);
      }
    } else if (this.speed > 0.18) {
      this.state = 'stop';
      this.slime.setSquash(0.2);
    } else {
      this.state = 'idle';
      this.slime.setSquash(0);
    }

    // step phase advances with actual distance travelled — no foot sliding
    this.stepPhase += (this.speed / 1.55) * dt;
    if (this.stepPhase > 1e4) this.stepPhase -= 1e4;

    // procedural body language
    const bob = this.grounded ? Math.abs(Math.sin(this.stepPhase * Math.PI)) * 0.055 * speedRatio : 0;
    const hop = this.grounded ? 0 : Math.sin(clamp01(this.verticalVel / this.jumpVel) * Math.PI * 0.5) * 0.03;
    this.visual.position.y = bob + hop;

    // lean into movement and into turns — a slime should visibly slant its whole
    // body into the direction it pours toward
    const yawRate = wrapAngle(this.targetYaw - this.yaw);
    this.strafeLean = damp(this.strafeLean, THREE.MathUtils.clamp(yawRate * 0.62, -0.42, 0.42), 7, dt);
    const forwardLean = speedRatio * 0.32 + this.sprintBlend * 0.14;

    // the body stays UPRIGHT; the base skirt (in slime.update) bends to follow
    // the terrain instead — conforming without tipping the gel over
    this.visual.rotation.x = forwardLean;
    this.visual.rotation.z = -this.strafeLean * 0.8;

    // jelly squash on take-off/landing arcs — big splat, springy rebound
    if (this.grounded && this.landTimer > 0) {
      this.slime.setSquash(Math.min(2.2, this.landImpact * 1.6));
    }

    const px = this.pos.x;
    const pz = this.pos.z;
    const py = this.pos.y;
    const yaw = this.yaw;
    const air = Math.max(0, this.pos.y - groundNow);
    this.slime.update(dt, speedRatio, (wx, wz) => this.field.height(wx, wz) - py, yaw, px, pz, air);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    // the blob shadow is only needed while the body is off the ground — on the
    // ground the real shadow map does the job and a second blob reads as a stain
    this.slime.contactBase = this.grounded && this.landTimer <= 0 ? 0 : 1;

    // the slime glances toward the camera when idle for that curious read
    if (this.state === 'idle') {
      this.slime.setLook(Math.sin(this.idleTimer * 0.8) * 0.5, 0);
    } else {
      this.slime.setLook(0, 0);
    }
  }

  /** Places the player on the ground exactly (used on spawn and after closing overlays). */
  snapToGround() {
    this.pos.y = this.field.height(this.pos.x, this.pos.z);
    this.group.position.copy(this.pos);
  }
}
