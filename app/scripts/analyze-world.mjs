import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const out = path.resolve('../runtime/.tmp/world.test.mjs');
await build({ entryPoints: ['src/game/world.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { IslandField, DEFAULT_WORLD, TILE, tileBounds } = await import(pathToFileURL(out).href);
const f = new IslandField(DEFAULT_WORLD);
const tiles = f.list();
let nan = 0;
const res = {};
const N = 60;
for (const t of tiles) {
  let land = 0, hi = -1e9, lo = 1e9, sum = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = t.x * TILE + (i / N - 0.5) * TILE, z = t.z * TILE + (j / N - 0.5) * TILE;
    const h = f.height(x, z);
    if (Number.isNaN(h)) nan++;
    if (h > 0.3) land++;

    hi = Math.max(hi, h); lo = Math.min(lo, h); sum += h;
  }
  const total = N * N;
  const key = `${t.x},${t.z}`;
  let inner = 0, innerN = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N - 0.5, v = j / N - 0.5;
    if (Math.abs(u) > 0.3 || Math.abs(v) > 0.3) continue;
    innerN++;
    if (f.height(t.x * TILE + u * TILE, t.z * TILE + v * TILE) > 0.3) inner++;
  }
  res[key] = { biome: t.biome, landPct: +(100 * land / total).toFixed(0), innerLandPct: +(100 * inner / innerN).toFixed(0), lo: +lo.toFixed(1), hi: +hi.toFixed(1), mean: +(sum / total).toFixed(1) };
}
console.table(res);
console.log('NaN', nan, 'spawn h', f.height(0, 12).toFixed(2), 'name', f.regionName(0, 12));
console.log('frontier', f.frontier().map(t => `${t.x},${t.z}`).join(' | '));
const b = tileBounds(tiles); console.log('bounds', b);
const t0 = performance.now(); let acc = 0;
for (let i = 0; i < 200000; i++) acc += f.height((i % 447) * 0.5 - 110, (Math.floor(i / 447) % 447) * 0.5 - 110);
console.log('height() us/call', ((performance.now() - t0) * 1000 / 200000).toFixed(2), acc > -1e9 ? '' : 'BAD');
