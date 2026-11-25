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

export type LocomotionState = 'idle' | 'start' | 'move' | 'stop' | 'turn' | 'prepare' | 'rise' | 'apex' | 'fall' | 'land' | 'wade' | 'swim' | 'dive';

/** dash: a short surge bought with stamina by clicking the bar */
const DASH_TIME = 0.34;
const DASH_COST = 0.18;
/** water deeper than this carries the slime: it floats and swims instead of walking on the bottom */
const SWIM_DEPTH = 0.58;
/** how far the body sits under the surface while it floats (BU) */
const FLOAT_DRAFT = 0.5;
/** the deepest the slime will dive */
const MAX_DIVE = 7;
/** one breath, in seconds */
const BREATH = 26;

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
  /** the water is deep enough here to swim in */
  inWater = false;
  /** held under the surface by the dive key */
  swimHold = false;
  private swimPhase = 0;
  /** 1 right after a splash into the water; the engine reads it to draw the ring */
  splash = 0;
  private wasInWater = false;

  /** True while the slime is in water deep enough to swim in. */
  get swimming() {
    return this.inWater;
  }

  /** True while the body is under the surface (the camera may still be above it). */
  get submerged() {
    return this.inWater && this.pos.y < -FLOAT_DRAFT - 0.2;
  }

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
  readonly swimSpeed = 2.3;
  readonly swimSprint = 3.7;
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
    // water carries the slime: slower, and it takes longer to get going or to stop
    const maxSpeed = lerp(this.inWater ? this.swimSpeed : this.walkSpeed, this.inWater ? this.swimSprint : this.sprintSpeed, this.sprintBlend);

    // accelerate toward the desired planar velocity (skipped during a dash, which
    // owns the velocity outright)
    if (this.dashTime <= 0) {
      const targetVX = desiredX * maxSpeed * moveLen;
      const targetVZ = desiredZ * maxSpeed * moveLen;
      const rate = this.inWater ? (moveLen > 0.06 ? 8 : 5) : moveLen > 0.06 ? this.accel : this.decel;
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

    // solid props standing in the water are pushed out of just like on land (below)

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
    // what is under the slime: the floor, and the water that may be standing on it
    const depth = -groundNow;
    this.inWater = depth > SWIM_DEPTH;
    const floatY = -FLOAT_DRAFT;
    this.splash = Math.max(0, this.splash - dt * 2.5);

    // jump with coyote time + input buffering; from the water only while floating
    if (intent.jump && !this.swimHold) this.jumpBuffer = 0.16;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0 && !this.swimHold) {
      // a leap out of the water is a little higher than a hop on land: enough to
      // clear a low bank and climb ashore
      this.verticalVel = this.inWater ? this.jumpVel * 1.16 : this.jumpVel;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.slime.setSquash(-0.7);
      this.state = 'prepare';
      if (this.inWater) this.splash = 1;
    }

    if (!this.grounded) {
      this.verticalVel -= this.gravity * dt;
      this.pos.y += this.verticalVel * dt;
      // coming down on the floor — or, over deep water, breaking the surface again
      const intoWater = this.inWater && this.verticalVel < 0 && this.pos.y <= floatY + 0.05;
      if (this.pos.y <= groundNow || intoWater) {
        const impact = Math.min(1, Math.abs(this.verticalVel) / 9);
        this.pos.y = intoWater ? floatY : groundNow;
        this.verticalVel = 0;
        this.grounded = true;
        this.landImpact = impact;
        this.landTimer = 0.26;
        this.slime.setSquash(impact * (intoWater ? 1.6 : 1.1));
        this.state = intoWater ? 'swim' : 'land';
        if (intoWater) this.splash = 1;
      }
    } else if (this.inWater) {
      if (this.pos.y > floatY + 0.3) {
        // walked off a bank into deep water: fall the short way to the surface
        this.grounded = false;
        this.verticalVel = 0;
      } else {
        if (!this.wasInWater) this.splash = 1; // waded or slipped in
        this.float(dt, intent, groundNow, floatY);
      }
    } else {
      // stick to the slope, with a small smoothing so steps don't jitter
      this.swimHold = false;
      this.pos.y = damp(this.pos.y, groundNow, 22, dt);
      if (Math.abs(this.pos.y - groundNow) < 0.02) this.pos.y = groundNow;
    }

    // ---- animation state machine ----
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.speedSmoothed = damp(this.speedSmoothed, this.speed, 12, dt);
    const speedRatio = clamp01(this.speedSmoothed / this.walkSpeed);

    if (this.grounded && this.inWater) {
      // borne by the water: a slow bob that quickens with the stroke, and a lean into it
      this.swimPhase += dt * (0.7 + speedRatio * 0.8);
      if (this.swimPhase > 1e4) this.swimPhase -= 1e4;
      this.state = this.swimHold ? 'dive' : 'swim';
      this.slime.setSquash(Math.sin(this.swimPhase * Math.PI * 2) * 0.09);
    } else if (!this.grounded) {
      if (this.verticalVel > 1.5) this.state = this.verticalVel > 4.2 ? 'rise' : 'apex';
      else if (this.verticalVel > -1.2) this.state = 'apex';
      else this.state = 'fall';
      if (this.state === 'apex') this.slime.setSquash(-0.25);
      else if (this.state === 'fall') this.slime.setSquash(0.16);
    } else if (this.landTimer > 0) {
      this.landTimer -= dt;
      this.state = 'land';
    } else if (speedRatio > 0.12) {
      if (depth > 0.08 && this.state !== 'wade') {
        // shin-deep water: walked through, not swum
        this.state = 'wade';
      }
      if (this.startTimer <= 0 && this.state !== 'move' && this.state !== 'wade') {
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
    const wading = this.grounded && this.inWater;
    const bob = wading ? Math.sin(this.swimPhase * Math.PI * 2) * 0.05 : this.grounded ? Math.abs(Math.sin(this.stepPhase * Math.PI)) * 0.055 * speedRatio : 0;
    const hop = this.grounded ? 0 : Math.sin(clamp01(this.verticalVel / this.jumpVel) * Math.PI * 0.5) * 0.03;
    this.visual.position.y = bob + hop;

    // lean into movement and into turns — a slime should visibly slant its whole
    // body into the direction it pours toward
    const yawRate = wrapAngle(this.targetYaw - this.yaw);
    this.strafeLean = damp(this.strafeLean, THREE.MathUtils.clamp(yawRate * 0.62, -0.42, 0.42), 7, dt);
    const forwardLean = speedRatio * (wading ? 0.2 : 0.32) + this.sprintBlend * (wading ? 0.06 : 0.14);

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
    this.wasInWater = this.inWater;
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

  /**
   * Borne by the water. Buoyancy settles the body at the surface; holding the dive
   * key pulls it down as far as the floor (or MAX_DIVE) allows, and letting go
   * brings it back up. Under the surface the stamina bar is the slime's breath:
   * when it runs out the slime is carried up whether the key is held or not.
   */
  private float(dt: number, intent: Intent, groundNow: number, floatY: number) {
    const under = this.pos.y < floatY - 0.2;
    this.swimHold = intent.dive && this.stamina > 0.02;
    const targetY = this.swimHold ? Math.max(groundNow + 0.1, -MAX_DIVE) : floatY;
    this.pos.y = damp(this.pos.y, targetY, this.swimHold ? 2.6 : 4.4, dt);
    this.verticalVel = 0;
    if (under) {
      this.stamina = Math.max(0, this.stamina - dt / BREATH);
      this.staminaCooldown = 0.8; // no getting it back while still under
    }
  }

  /** Places the player on the ground — or on the water — exactly (used on spawn and after closing overlays). */
  snapToGround() {
    const ground = this.field.height(this.pos.x, this.pos.z);
    this.inWater = -ground > SWIM_DEPTH;
    this.pos.y = this.inWater ? -FLOAT_DRAFT : ground;
    this.group.position.copy(this.pos);
  }
}
