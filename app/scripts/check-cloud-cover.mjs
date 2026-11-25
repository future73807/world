// Is the loading screen's cloud deck opaque everywhere?
//
// The load screen is covered by nothing but cloud lobes (`.boot-mist i` in
// app/src/ui/ui.css, laid out by useCloudLobes() in app/src/App.tsx). Lobes are
// soft-edged, so "covered" is a number: this rebuilds the same layout with the
// same random draws and composites the same radial profile on a grid over the
// whole frame, then reports the thinnest point. Anything under the threshold
// means the half-built world shows through between the clouds.
//
// If you change the layout in useCloudLobes(), mirror it here (the order of the
// random draws is part of the layout) and run:  npm run clouds:cover
//
// Widths are % of the frame width and heights % of its height, and both the
// positions and the radii scale with the same axis, so the normalised sum does
// not depend on the frame's aspect ratio: one number covers every window size.

/** alpha of one lobe at normalised radius r — the stops of `.boot-mist i` */
const prof = (r) =>
  r >= 1 ? 0
  : r <= 0.62 ? 1
  : r <= 0.74 ? 1 - ((r - 0.62) / 0.12) * 0.01
  : r <= 0.84 ? 0.99 - ((r - 0.74) / 0.10) * 0.09
  : 0.9 * (1 - (r - 0.84) / 0.16);

const rndGen = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Mirrors useCloudLobes(): same constants, same order of draws. */
function layout(seed) {
  const rnd = rndGen(seed);
  const cols = 10;
  const rows = 9;
  const pad = 10;
  const stepX = (100 + 2 * pad) / cols;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = 24 + rnd() * 14;
      const k = 1.0 + rnd() * 0.45;
      const slide = r % 2 ? stepX * 0.5 : 0;
      const cx = -pad + (c + 0.5) * stepX + slide + (rnd() - 0.5) * 9;
      const cy = -pad + ((r + 0.5) / rows) * (100 + 2 * pad) + (rnd() - 0.5) * 8;
      rnd(); rnd(); // the outward direction (two draws)
      rnd(); // the delay
      rnd(); // the underside shading
      out.push({ cx, cy, a: w / 2, b: (w * k) / 2 });
    }
  }
  return out;
}

/** Thinnest composite alpha over a grid covering the frame (0..100 on both axes). */
function thinnest(lobes) {
  const N = 300;
  const M = 170;
  let min = 1;
  let at = null;
  for (let j = 0; j <= M; j++) {
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * 100;
      const y = (j / M) * 100;
      let clear = 1;
      for (const l of lobes) {
        // normalised radius inside the lobe's ellipse: 1 at its edge
        clear *= 1 - prof(Math.hypot((x - l.cx) / l.a, (y - l.cy) / l.b));
      }
      const a = 1 - clear;
      if (a < min) {
        min = a;
        at = [Math.round((i / N) * 100), Math.round((j / M) * 100)];
      }
    }
  }
  return { min: +min.toFixed(5), at };
}

const SHIPPED = 20261123;
const THRESHOLD = 0.995;
const ship = thinnest(layout(SHIPPED));
const worst = [7, 12345, 99991, 555, 424242]
  .map((s) => ({ s, ...thinnest(layout(s)) }))
  .sort((a, b) => a.min - b.min)[0];

const pct = (v) => (v * 100).toFixed(3) + '%';
console.log(`cloud deck: ${layout(SHIPPED).length} lobes`);
console.log(`  shipped seed  thinnest ${pct(ship.min)} at (${ship.at.join('%, ')}%)`);
console.log(`  other seeds   worst    ${pct(worst.min)} (seed ${worst.s})`);
if (ship.min < THRESHOLD) {
  console.error(`FAIL: the deck shows the world through it (below ${pct(THRESHOLD)}) — enlarge or add lobes in useCloudLobes().`);
  process.exit(1);
}
console.log(`ok: no point on the frame is thinner than ${pct(THRESHOLD)}`);
