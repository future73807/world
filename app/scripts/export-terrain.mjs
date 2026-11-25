/**
 * Export the birth island's terrain for the Blender project.
 *
 *   node scripts/export-terrain.mjs
 *
 * Runs the very same world code the browser boots with (bundled with esbuild)
 * and writes, for every terrain chunk the game would take from Blender:
 *   ../world/terrain/birth_chunks.f32   positions, colours and indices (float32)
 *   ../world/terrain/birth_index.json    chunk list + offsets
 * build_terrain.py then builds the Blender project from it, exports birth.glb,
 * and writes the height grid back out of the Blender meshes.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const app = path.resolve(here, '..');
const root = path.resolve(app, '..');
const outDir = path.resolve(root, 'world', 'terrain');
const bundle = path.resolve(root, 'runtime', '.tmp', 'terrain-export.mjs');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(bundle), { recursive: true });
await build({
  // a tiny entry that re-exports the terrain builder together with the world model
  stdin: {
    contents: "export * from './src/game/terrain'; export { IslandField, DEFAULT_WORLD, CHUNK, SUBDIV, TILE, connectTiles } from './src/game/world';",
    resolveDir: app,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const T = await import(pathToFileURL(bundle).href);
const { IslandField, DEFAULT_WORLD, CHUNK, SUBDIV, TILE, connectTiles } = T;

const settings = DEFAULT_WORLD;
const field = new IslandField(settings, true);
const spawn = { x: 0, z: 12 };
const ok = (x, z) => field.height(x, z) > 1 && field.height(x, z) < 7 && field.slope(x, z) < 0.32;
if (!ok(spawn.x, spawn.z)) {
  outer: for (let r = 2; r <= 16; r += 1.5) {
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      if (ok(Math.cos(a) * r, spawn.z + Math.sin(a) * r)) {
        spawn.x = Math.cos(a) * r;
        spawn.z = spawn.z + Math.sin(a) * r;
        break outer;
      }
    }
  }
}
const bridges = connectTiles(field, spawn.x, spawn.z);

const pristine = (t) => !!t && (!t.spec.source || t.spec.source === 'preset') && t.spec.peak === undefined && !t.spec.props;
const isBirthChunk = (cx, cz) => {
  const pad = CHUNK * 0.5 + TILE * 0.66;
  const x0 = cx * CHUNK - pad;
  const x1 = cx * CHUNK + pad;
  const z0 = cz * CHUNK - pad;
  const z1 = cz * CHUNK + pad;
  for (let tz = Math.round(z0 / TILE); tz <= Math.round(z1 / TILE); tz++) {
    for (let tx = Math.round(x0 / TILE); tx <= Math.round(x1 / TILE); tx++) {
      const t = field.get(tx, tz);
      if (t && !pristine(t)) return false;
    }
  }
  return true;
};

const r = T.chunkRange(field.list(), 1);
const floats = [];
const chunks = [];
const heights = [];
const n = SUBDIV + 1;
const step = CHUNK / SUBDIV;
let tris = 0;
for (let j = r.z0; j <= r.z1; j++) {
  for (let i = r.x0; i <= r.x1; i++) {
    if (T.isDeepSea(field, i, j) || !isBirthChunk(i, j)) continue;
    const geo = T.buildChunkMesh(field, i, j);
    const pos = geo.getAttribute('position').array;
    const col = geo.getAttribute('color').array;
    const idx = geo.getIndex().array;
    const v = geo.getAttribute('position').count;
    const ic = idx.length;
    // po / co / io are FLOAT indices into birth_chunks.f32 (positions, colours, then indices)
    chunks.push({ cx: i, cz: j, v, i: ic / 3, po: floats.length, co: floats.length + pos.length, io: floats.length + pos.length + col.length });
    for (let k = 0; k < pos.length; k++) floats.push(pos[k]);
    for (let k = 0; k < col.length; k++) floats.push(col[k]);
    for (let k = 0; k < ic; k++) floats.push(idx[k]);
    // the regular height grid the game samples for collision
    for (let jj = 0; jj < n; jj++) for (let ii = 0; ii < n; ii++) heights.push(field.height(i * CHUNK + ii * step, j * CHUNK + jj * step));
    tris += ic / 3;
  }
}

fs.writeFileSync(path.join(outDir, 'birth_chunks.f32'), Buffer.from(new Float32Array(floats).buffer));
fs.writeFileSync(path.join(outDir, 'birth_heights.f32'), Buffer.from(new Float32Array(heights).buffer));
const index = { seed: settings.seed, grid: n, spawn, bridges, chunks: chunks.map((c) => [c.cx, c.cz]), layout: chunks };
fs.writeFileSync(path.join(outDir, 'birth_index.json'), JSON.stringify(index));
console.log(
  `exported ${chunks.length} chunks (${tris.toLocaleString()} triangles, ${(floats.length * 4 / 1048576).toFixed(2)} MB) ` +
    `for ${field.list().length} tiles, ${bridges} causeway(s)`,
);
