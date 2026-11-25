import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#737f88');
const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 200);
camera.position.set(24, 30, 28);
camera.lookAt(0, 0, 0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x566047, 2.0));
const sun = new THREE.DirectionalLight(0xfff2d2, 2.6);
sun.position.set(-12, 28, 18);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xbfe1ff, 0.8);
fill.position.set(16, 8, 12);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(160, 160),
  new THREE.MeshStandardMaterial({ color: 0x626e75, roughness: 1 }),
);
ground.position.y = -0.04;
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const manifest = await fetch('/app/public/models/prefabs.json').then((r) => r.json());
const gltf = await new GLTFLoader().loadAsync('/app/public/models/prefabs.glb');
const root = new THREE.Group();
scene.add(root);
const byId = new Map();
for (const mesh of gltf.scene.children) {
  if (!mesh.isMesh) continue;
  const id = mesh.name.replace(/(__glow)?(__lod1)?$/, '');
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(mesh);
}

const mainMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.88,
  metalness: 0,
  side: THREE.DoubleSide,
});
const glowMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.6,
  emissive: 0xffffff,
  emissiveIntensity: 1.1,
  side: THREE.DoubleSide,
});

function labelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.font = '28px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f4fbff';
  ctx.shadowColor = '#0009';
  ctx.shadowBlur = 6;
  ctx.fillText(text, 256, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(3.6, 0.675, 1);
  return sprite;
}

const ids = Object.keys(manifest.models).sort();
const wrappers = new Map();
const cols = 8;
const spacing = 4.6;
ids.forEach((id, index) => {
  const wrapper = new THREE.Group();
  wrapper.userData.id = id;
  const content = new THREE.Group();
  wrapper.add(content);
  for (const source of byId.get(id) ?? []) {
    if (source.name.endsWith('__lod1')) continue;
    const mesh = new THREE.Mesh(source.geometry, source.name.includes('__glow') ? glowMaterial : mainMaterial);
    content.add(mesh);
  }
  content.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(content);
  const size = box.getSize(new THREE.Vector3());
  const k = Math.min(1, 3.25 / Math.max(size.x, size.y, size.z));
  content.scale.setScalar(k);
  content.position.set(-(box.min.x + box.max.x) * 0.5 * k, -box.min.y * k, -(box.min.z + box.max.z) * 0.5 * k);
  const x = (index % cols - (cols - 1) / 2) * spacing;
  const y = -Math.floor(index / cols) * spacing;
  wrapper.position.set(x, 0, y);
  const label = labelSprite(`${id} · h ${manifest.models[id].size[1].toFixed(1)}`);
  label.position.set(0, 0.12, 1.85);
  wrapper.add(label);
  wrapper.userData.label = label;
  root.add(wrapper);
  wrappers.set(id, wrapper);
});

function frameAll() {
  for (const wrapper of wrappers.values()) {
    wrapper.visible = true;
    wrapper.userData.label.visible = true;
  }
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  const rows = Math.ceil(ids.length / cols);
  controls.target.set(0, 0.8, -rows * spacing * 0.5);
  camera.position.copy(controls.target).add(new THREE.Vector3(22, 30, 28));
  camera.left = -cols * spacing * 0.62;
  camera.right = cols * spacing * 0.62;
  camera.top = cols * spacing * 0.62;
  camera.bottom = -cols * spacing * 0.62;
  camera.updateProjectionMatrix();
  controls.update();
}

function show(id) {
  for (const [key, wrapper] of wrappers) {
    wrapper.visible = key === id;
    wrapper.userData.label.visible = false;
    if (key === id) wrapper.position.set(0, 0, 0);
  }
  controls.target.set(0, 1.5, 0);
  camera.position.set(6, 7, 9);
  camera.left = -4.2;
  camera.right = 4.2;
  camera.top = 4.2;
  camera.bottom = -4.2;
  camera.updateProjectionMatrix();
  controls.update();
  document.querySelector('#hud').textContent = id;
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  render();
});
function render() {
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(render);
frameAll();
window.__assetReview = { scene, root, wrappers, camera, renderer, show, frameAll, ids };
window.__reviewReady = true;
