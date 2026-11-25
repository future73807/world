import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '..');
const glbPath = path.join(app, 'public', 'models', 'prefabs.glb');
const manifestPath = path.join(app, 'public', 'models', 'prefabs.json');
const reportPath = path.join(root, 'world_v2', 'renders', 'build_report.json');

const keptTris = {
  palm_a: [3128, 420],
  palm_b: [2536, 354],
  desert_cactus_a: [1064, 487],
  desert_cactus_b: [422, 174],
  snow_pine_a: [322, 94],
  snow_pine_b: [259, 74],
  snow_pine_c: [385, 114],
  landmark_elder_tree: [1736, 594],
};

const fail = (message) => {
  console.error(`[assets] ${message}`);
  process.exit(1);
};

const binary = fs.readFileSync(glbPath);
if (binary.toString('ascii', 0, 4) !== 'glTF') fail('prefabs.glb is not a GLB container');
const jsonLength = binary.readUInt32LE(12);
const gltf = JSON.parse(binary.subarray(20, 20 + jsonLength).toString('utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const models = manifest.models;
const ids = Object.keys(models).sort();

if (manifest.version !== 2) fail(`expected manifest version 2, got ${manifest.version}`);
if (ids.length !== 55) fail(`expected 55 models, got ${ids.length}`);
if (report.rebuilt.length !== 47 || report.kept.length !== 8) fail('build report does not cover 47 rebuilt + 8 kept models');

const meshNames = gltf.meshes.map((mesh) => mesh.name);
if (new Set(meshNames).size !== meshNames.length) fail('GLB contains duplicate mesh names');
if (meshNames.some((name) => /\.\d+$/.test(name))) fail('GLB contains suffixed mesh names such as .001');

const triangles = (mesh) => {
  let total = 0;
  for (const primitive of mesh.primitives) {
    const index = primitive.indices;
    if (index !== undefined) total += gltf.accessors[index].count / 3;
    else total += gltf.accessors[primitive.attributes.POSITION].count / 3;
  }
  return total;
};

const expectedMeshes = new Set();
for (const id of ids) {
  const entry = models[id];
  if (!Array.isArray(entry.size) || entry.size.length !== 3 || entry.size.some((v) => !(v > 0) || !Number.isFinite(v))) {
    fail(`${id} has an invalid size`);
  }
  const near = gltf.meshes.find((mesh) => mesh.name === id);
  const lod = gltf.meshes.find((mesh) => mesh.name === `${id}__lod1`);
  if (!near || !lod) fail(`${id} is missing its near or LOD mesh`);
  for (const mesh of [near, lod]) {
    for (const primitive of mesh.primitives) {
      if (primitive.attributes.POSITION === undefined || primitive.attributes.COLOR_0 === undefined) fail(`${mesh.name} is missing position or colour attributes`);
    }
  }
  expectedMeshes.add(id);
  expectedMeshes.add(`${id}__lod1`);
  let nearTris = triangles(near);
  let lodTris = triangles(lod);
  if (entry.glow) {
    const glow = gltf.meshes.find((mesh) => mesh.name === `${id}__glow`);
    const glowLod = gltf.meshes.find((mesh) => mesh.name === `${id}__glow__lod1`);
    if (!glow || !glowLod) fail(`${id} is missing its glow mesh or glow LOD`);
    for (const mesh of [glow, glowLod]) {
      for (const primitive of mesh.primitives) {
        if (primitive.attributes.POSITION === undefined || primitive.attributes.COLOR_0 === undefined) fail(`${mesh.name} is missing position or colour attributes`);
      }
    }
    nearTris += triangles(glow);
    lodTris += triangles(glowLod);
    expectedMeshes.add(`${id}__glow`);
    expectedMeshes.add(`${id}__glow__lod1`);
  }
  if (nearTris !== entry.tris) fail(`${id} manifest near triangles ${entry.tris} do not match GLB ${nearTris}`);
  if (lodTris !== entry.lod1Tris) fail(`${id} manifest LOD triangles ${entry.lod1Tris} do not match GLB ${lodTris}`);
  if (lodTris > nearTris) fail(`${id} LOD has more triangles than near mesh`);
  if (keptTris[id] && (entry.tris !== keptTris[id][0] || entry.lod1Tris !== keptTris[id][1])) {
    fail(`${id} was supposed to stay unchanged`);
  }
  if (report.rebuilt.includes(id) && Math.abs(entry.base + entry.sink) > 0.002) fail(`${id} is not seated at ground level`);
  const colliders = entry.collide === false ? [] : Array.isArray(entry.collide) ? entry.collide : [entry.collide];
  for (const collider of colliders) {
    if (!Number.isFinite(collider.r) || collider.r <= 0 || !Number.isFinite(collider.h) || collider.h <= 0) fail(`${id} has an invalid collider`);
    if ('x' in collider && (!Number.isFinite(collider.x) || !Number.isFinite(collider.z))) fail(`${id} has an invalid foot collider`);
  }
  if (entry.kind === 'tree' && entry.collide === false) fail(`${id} tree has no collision`);
  if (id === 'landmark_crystal' && entry.size[1] < 5) fail('frost crystal landmark is not tall enough');
  if (id === 'ice_shard' && entry.size[1] < 1.5) fail('ice shard is not tall enough');
  if (id === 'volcano_obsidian' && entry.size[1] < 1.7) fail('obsidian cluster is not tall enough');
}

const actualMeshes = new Set(meshNames);
for (const name of expectedMeshes) if (!actualMeshes.has(name)) fail(`missing expected mesh ${name}`);
for (const name of actualMeshes) if (!expectedMeshes.has(name)) fail(`unexpected mesh ${name}`);

console.table(ids.map((id) => ({ id, near: models[id].tris, lod: models[id].lod1Tris, glow: models[id].glow })));
console.log(`[assets] OK: ${ids.length} models, ${expectedMeshes.size} meshes, 8 kept unchanged, 47 rebuilt, colours + LOD + collision + grounding verified.`);
