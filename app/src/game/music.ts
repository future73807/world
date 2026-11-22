/**
 * Ambient music: a light, bright music-box loop. Original composition for this
 * project — a C-major pentatonic bell melody over warm major thirds.
 *
 * The earlier track sat in A minor with a 9-second chord bed and read as
 * "melancholy / slightly out of tune" in playtesting. This version keeps the
 * music-box timbre but moves to C major, roughly doubles the note density, and
 * uses short arpeggiated chords, which is what makes a loop feel buoyant rather
 * than mournful. No external audio — scheduled with WebAudio.
 */

/** C-major pentatonic, two octaves: C D E G A. */
const P = [523.25, 587.33, 659.26, 783.99, 880.0, 1046.5, 1174.66, 1318.5];

/** One 4-bar phrase, 16 steps per bar. Indices into P; -1 rests. */
const MELODY: number[] = [
  // bar 1 — rising motif, settles on E
  0, 2, 4, 2, 3, 2, 1, -1,
  // bar 2 — answer, one step higher
  2, 4, 5, 4, 3, 2, 0, -1,
  // bar 3 — lift into the upper octave
  4, 5, 7, 5, 6, 5, 3, -1,
  // bar 4 — come back home, leave space for the loop
  4, 3, 2, 1, 0, -1, -1, -1,
];

/** Warm major-third and fifth beds — C, then F, then G, then back to C. */
const CHORDS: number[][] = [
  [130.81, 164.81, 196.0], // C3 E3 G3
  [174.61, 220.0, 261.63], // F3 A3 C4
  [196.0, 246.94, 293.66], // G3 B3 D4
  [130.81, 164.81, 196.0],
];

const STEP = 0.18; // seconds per step — a gentle running lilt, not a waltz

export class AmbientMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private targetVolume = 0;

  setEnabled(on: boolean, volume: number) {
    this.targetVolume = (volume / 100) * 0.34;
    if (on) {
      this.ensure();
      if (this.ctx && this.master) {
        this.master.gain.setTargetAtTime(Math.max(0.0001, this.targetVolume), this.ctx.currentTime, 0.6);
        void this.ctx.resume();
      }
    } else if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.35);
    }
  }

  private ensure() {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;
    // a soft top-end roll-off: raw sines at these frequencies read as piercing
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.4;
    this.master.connect(lp);
    lp.connect(this.ctx.destination);
    this.nextTime = this.ctx.currentTime + 0.2;
    this.timer = window.setInterval(() => this.schedule(), 200);
  }

  /** lookahead scheduler: keeps ~0.8s of score queued */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextTime < ctx.currentTime + 0.8) {
      const bar = Math.floor(this.step / 16) % 4;
      const i = this.step % MELODY.length;
      const note = MELODY[i];
      if (note >= 0) this.pluck(P[note], this.nextTime);

      // chord: soft arpeggio at the head of each bar, not a sustained drone
      if (this.step % 16 === 0) {
        const chord = CHORDS[bar];
        for (let k = 0; k < chord.length; k++) {
          this.pad(chord[k], this.nextTime + k * 0.045, 0.05);
        }
      }
      this.step++;
      this.nextTime += STEP;
    }
  }

  /** music-box tine: fast attack, long bell decay, one quiet octave partial */
  private pluck(freq: number, t: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.26, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    g.connect(this.master!);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g);
    o.start(t);
    o.stop(t + 1.35);

    // the octave partial is what makes it read as a tine rather than a beep
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.055, t + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o2.connect(g2);
    g2.connect(this.master!);
    o2.start(t);
    o2.stop(t + 0.6);
  }

  /** short warm bed under the bar, triangle for a softer odd-harmonic edge */
  private pad(freq: number, t: number, amp: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + 2.6);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 2.7);
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
