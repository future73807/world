/** Unified input: keyboard, pointer lock, wheel, touch. Emits a polled intent object. */

export type Intent = {
  moveX: number;
  moveZ: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
  interact: boolean;
  pressed: Set<string>;
};

export type InputDevice = 'kbm' | 'touch';

export class InputController {
  readonly intent: Intent = {
    moveX: 0,
    moveZ: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    sprint: false,
    interact: false,
    pressed: new Set(),
  };

  device: InputDevice = 'kbm';
  locked = false;
  /** true while any overlay (map/pause/create) owns the pointer */
  suspendLook = false;

  private keys = new Set<string>();
  private justPressed = new Set<string>();
  private pendingLookX = 0;
  private pendingLookY = 0;
  private wheelDelta = 0;
  private pointerDown = false;
  private lastPointer = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private touchLook = { x: 0, y: 0 };
  private touchSprint = false;
  /** right mouse button held = sprint */
  private rmbSprint = false;
  private touchInteract = false;
  private dom: HTMLElement;
  private disposers: (() => void)[] = [];
  private touchLookId: number | null = null;
  private touchStickId: number | null = null;
  private touchStickOrigin = { x: 0, y: 0 };
  private touchLookOrigin = { x: 0, y: 0 };
  private onDeviceChange?: (d: InputDevice) => void;

  constructor(dom: HTMLElement) {
    this.dom = dom;
    this.bind();
  }

  onDevice(cb: (d: InputDevice) => void) {
    this.onDeviceChange = cb;
  }

  private bind() {
    const add = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    add(window, 'keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.justPressed.add(k);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) {
        e.preventDefault();
      }
      this.markKbm();
    });
    add(window, 'keyup', (e) => {
      this.keys.delete(e.code);
    });
    add(window, 'blur', () => {
      this.keys.clear();
      this.pointerDown = false;
      this.stick.x = 0;
      this.stick.y = 0;
    });

    add(this.dom, 'pointerdown', (e) => {
      if (this.suspendLook) return;
      if (e.pointerType === 'touch') {
        this.markTouch();
        const half = this.dom.clientWidth * 0.42;
        if (e.clientX < half && this.touchStickId === null) {
          this.touchStickId = e.pointerId;
          this.touchStickOrigin = { x: e.clientX, y: e.clientY };
        } else if (this.touchLookId === null) {
          this.touchLookId = e.pointerId;
          this.touchLookOrigin = { x: e.clientX, y: e.clientY };
        }
        return;
      }
      this.markKbm();
      // right mouse button = sprint for as long as it is held
      if (e.button === 2) {
        this.rmbSprint = true;
        return;
      }
      this.pointerDown = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      // single click on the canvas requests pointer lock — camera never snaps back
      if (!this.locked && this.dom.requestPointerLock) {
        this.dom.requestPointerLock();
      }
    });

    // the right button must never open the browser menu mid-sprint
    add(this.dom, 'contextmenu', (e) => e.preventDefault());

    add(window, 'pointerup', (e) => {
      if (e.button === 2) this.rmbSprint = false;
      if (e.pointerType === 'touch') {
        if (e.pointerId === this.touchStickId) {
          this.touchStickId = null;
          this.stick.x = 0;
          this.stick.y = 0;
        }
        if (e.pointerId === this.touchLookId) this.touchLookId = null;
        return;
      }
      this.pointerDown = false;
    });

    add(window, 'pointermove', (e) => {
      if (this.suspendLook) return;
      if (e.pointerType === 'touch') {
        if (e.pointerId === this.touchStickId) {
          const dx = e.clientX - this.touchStickOrigin.x;
          const dy = e.clientY - this.touchStickOrigin.y;
          const max = 62;
          const len = Math.hypot(dx, dy);
          const clampLen = Math.min(1, len / max);
          const nx = len > 0 ? (dx / len) * clampLen : 0;
          const ny = len > 0 ? (dy / len) * clampLen : 0;
          this.stick.x = nx;
          this.stick.y = ny;
        } else if (e.pointerId === this.touchLookId) {
          const dx = e.clientX - this.touchLookOrigin.x;
          const dy = e.clientY - this.touchLookOrigin.y;
          this.touchLookOrigin = { x: e.clientX, y: e.clientY };
          this.touchLook.x += dx;
          this.touchLook.y += dy;
        }
        return;
      }
      if (this.locked) {
        this.pendingLookX += e.movementX;
        this.pendingLookY += e.movementY;
      } else if (this.pointerDown) {
        // drag fallback when pointer lock is unavailable
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.pendingLookX += dx;
        this.pendingLookY += dy;
      }
    });

    const onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.pendingLookX = 0;
        this.pendingLookY = 0;
      }
    };
    document.addEventListener('pointerlockchange', onLockChange);
    this.disposers.push(() => document.removeEventListener('pointerlockchange', onLockChange));
    add(
      this.dom,
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheelDelta += e.deltaY;
      },
      { passive: false },
    );
  }

  private markKbm() {
    if (this.device !== 'kbm') {
      this.device = 'kbm';
      this.onDeviceChange?.('kbm');
    }
  }
  private markTouch() {
    if (this.device !== 'touch') {
      this.device = 'touch';
      this.onDeviceChange?.('touch');
    }
  }

  setTouchSprint(v: boolean) {
    this.touchSprint = v;
  }

  /** Touch/keyboard-agnostic requests so UI code never touches internals. */
  requestJump() {
    this.justPressed.add('Space');
  }

  requestInteract(v: boolean) {
    this.touchInteract = v;
  }

  /** Virtual stick values from the on-screen joystick. */
  setStick(x: number, y: number) {
    this.stick.x = x;
    this.stick.y = y;
  }

  /** Called once per frame after every consumer has read the state. */
  poll(): Intent {
    const moveX =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) +
      this.stick.x;
    const moveZ =
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) -
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) +
      this.stick.y;
    const i = this.intent;
    i.moveX = Math.max(-1, Math.min(1, moveX));
    i.moveZ = Math.max(-1, Math.min(1, moveZ));
    i.lookX = this.pendingLookX + this.touchLook.x;
    i.lookY = this.pendingLookY + this.touchLook.y;
    i.jump = this.keys.has('Space') || this.justPressed.has('Space');
    i.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint || this.rmbSprint;
    i.interact = this.keys.has('KeyE') || this.touchInteract;
    i.pressed = new Set(this.justPressed);
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    this.touchLook.x = 0;
    this.touchLook.y = 0;
    this.justPressed.clear();
    return i;
  }

  consumeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  wasPressed(code: string): boolean {
    return this.intent.pressed.has(code);
  }

  releaseLock() {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
    this.keys.clear();
    this.rmbSprint = false;
    this.pointerDown = false;
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
