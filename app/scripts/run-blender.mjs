/**
 * Runs one of the Blender asset pipelines headlessly with the Blender it finds.
 *
 *   node scripts/run-blender.mjs prefabs         rebuild the v2 prefab library
 *                                                 (world_v2/prefabs.blend → app/public/models)
 *   node scripts/run-blender.mjs terrain         build the birth terrain      (world/terrain.blend → app/public/terrain)
 *   node scripts/run-blender.mjs terrain-export  re-export a hand-edited terrain.blend without rebuilding it
 *   node scripts/run-blender.mjs gui             open the prefab project in a Blender window instead
 *
 * Set BLENDER_PATH if Blender is not in a standard install folder.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from '../../server/blender.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '..');
const blenderDir = path.join(root, 'world', 'blender');
const which = process.argv[2] || 'prefabs';

const found = findBlender(process.env.BLENDER_PATH || '');
if (!found) {
  console.error('Blender not found. Install it, or set BLENDER_PATH to blender.exe.');
  process.exit(1);
}
const exe = found.path;

const jobs = {
  // The prefab build opens the saved project when there is one, so whatever else
  // the file contains is kept. The models themselves always come from the recipes:
  // the three generated collections are purged and rebuilt, so a model edited by
  // hand in the window is replaced — change its recipe JSON instead.
  prefabs: () => ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, 'world_v2', 'blender', 'build_prefabs.py')],
  terrain: () => ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(blenderDir, 'build_terrain.py')],
  // the open project's chunk meshes are exported as they are (sculpted or edited)
  'terrain-export': () => ['-b', path.join(root, 'world', 'terrain.blend'), '--python-exit-code', '1', '--python', path.join(blenderDir, 'build_terrain.py'), '--', '--export-only'],
};

if (which === 'gui') {
  console.log(`opening ${path.join(root, 'world_v2', 'prefabs.blend')} in ${exe}`);
  const child = spawn(exe, [path.join(root, 'world_v2', 'prefabs.blend')], { detached: true, stdio: 'ignore' });
  child.unref();
  process.exit(0);
}

const args = jobs[which]?.();
if (!args) {
  console.error(`unknown pipeline "${which}" — use prefabs, terrain, terrain-export or gui`);
  process.exit(1);
}
console.log(`> ${exe} ${args.join(' ')}`);
const t0 = Date.now();
const r = spawnSync(exe, args, { stdio: 'inherit' });
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${r.status}`);
process.exit(r.status ?? 1);
