/**
 * Mist Isles local game server (no dependencies beyond Node 22 and the app's esbuild).
 *
 *   node server/index.mjs                 API only (used behind the Vite dev proxy)
 *   node server/index.mjs --static app/dist   also serve the built game
 *
 * What lives here and nowhere else:
 *   - AI provider settings and keys   runtime/secrets.json  (never sent to the browser)
 *   - region jobs: AI card / local recipe -> validated spec -> optional Blender build
 *   - the GLB files Blender builds at runtime                  runtime/generated/<job>/
 * The browser only ever sees masked configuration and finished results.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chat } from './ai.mjs';
import { findBlender, blenderVersion, runBlenderScript } from './blender.mjs';
import { planRegion } from './region.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const RUNTIME = path.join(ROOT, 'runtime');
const SECRETS = path.join(RUNTIME, 'secrets.json');
const GENERATED = path.join(RUNTIME, 'generated');
const LOGS = path.join(RUNTIME, 'logs');
const BLENDER_SCRIPT = path.join(ROOT, 'world', 'blender', 'build_recipe.py');
const CATALOG_FILE = path.join(ROOT, 'app', 'public', 'models', 'prefabs.json');
for (const d of [RUNTIME, GENERATED, LOGS, path.join(RUNTIME, '.tmp')]) fs.mkdirSync(d, { recursive: true });

const argv = process.argv.slice(2);
const staticArg = argv.includes('--static') ? argv[argv.indexOf('--static') + 1] : null;
const STATIC_DIR = staticArg ? path.resolve(ROOT, staticArg) : null;
const PORT = Number(process.env.PORT || 8787);

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(path.join(LOGS, 'server.log'), text + '\n');
  } catch {
    /* logging must never break a request */
  }
}

// --------------------------------------------------------------------------- biome tables

/** The biome tables are bundled straight from the game source, so server and browser never disagree. */
async function loadBiomes() {
  const require = createRequire(path.join(ROOT, 'app', 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
  const out = path.join(RUNTIME, '.tmp', 'server-biomes.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'app', 'src', 'game', 'biomes.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'error',
  });
  return import(pathToFileURL(out).href);
}

function loadCatalog() {
  try {
    const man = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    return Object.values(man.models || {}).map((m) => ({ id: m.id, label: m.label, kind: m.kind, biomes: m.biomes, desc: m.desc }));
  } catch (e) {
    log(`catalog unavailable: ${e.message}`);
    return [];
  }
}

// --------------------------------------------------------------------------- built models

/**
 * Every model Blender has built for a region so far, newest job first: id → entry
 * with the address it is served from. Saves keep these addresses, and the AI may
 * reuse a model that already exists instead of asking Blender for a new one.
 * Nothing here is ever deleted: a saved region may still point at any of it.
 */
const built = new Map();

function loadBuilt() {
  built.clear();
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(GENERATED, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, time: fs.statSync(path.join(GENERATED, d.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    const dir = path.join(GENERATED, d.name, 'models');
    let man;
    try {
      man = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const m of man.models || []) {
      if (typeof m?.id !== 'string' || !fs.existsSync(path.join(dir, `${m.id}.glb`))) continue;
      built.set(m.id, { ...m, jobId: d.name, url: `/generated/${d.name}/models/${m.id}.glb` });
    }
  }
}

// --------------------------------------------------------------------------- secrets & config

const DEFAULT_SECRETS = { provider: { enabled: true, base_url: '', model: '', key: '', probe: null }, allow_blender: true, blender_path: '' };

function loadSecrets() {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
    // the file once held a table of providers: the one that was in use is the configuration now
    const old = j.providers?.[j.active_provider] || {};
    const p = j.provider || (old.base_url || old.key || old.model ? old : {});
    return {
      provider: { enabled: p.enabled !== false, base_url: p.base_url || '', model: p.model || '', key: p.key || '', probe: p.probe || null },
      allow_blender: j.allow_blender !== false,
      blender_path: j.blender_path || '',
    };
  } catch {
    return { provider: { ...DEFAULT_SECRETS.provider }, allow_blender: true, blender_path: '' };
  }
}

let secrets = loadSecrets();

/** Blocks the thread for `ms` without burning CPU (the server is single-threaded; this is rare). */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function saveSecrets() {
  const text = JSON.stringify(secrets, null, 1);
  const tmp = SECRETS + '.tmp';
  // Renaming over an existing file can fail with EPERM on some machines (an antivirus
  // scan or a held handle). Retry a few times, then write in place rather than lose the change.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, SECRETS);
      return;
    } catch (e) {
      if (attempt >= 4) {
        fs.writeFileSync(SECRETS, text);
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* nothing left to remove */
        }
        log(`secrets written in place after rename kept failing: ${e?.code || e}`);
        return;
      }
      sleepSync(40 * (attempt + 1));
    }
  }
}

/** What the model adapter receives (key included). Never sent to the browser as a whole. */
const providerConfig = () => ({ id: 'custom', base_url: secrets.provider.base_url, model: secrets.provider.model, key: secrets.provider.key });

const keyHint = (key) => (key ? key.slice(-4) : '');

const modelHost = () => {
  try {
    return new URL(secrets.provider.base_url).host;
  } catch {
    return 'AI';
  }
};

/** True when the model can be called right now. */
const isReady = () => secrets.provider.enabled !== false && !!secrets.provider.model && !!secrets.provider.key;

// --------------------------------------------------------------------------- blender

let blender = { path: '', available: false, version: '', candidates: [] };

async function refreshBlender() {
  const found = findBlender(secrets.blender_path);
  if (!found) {
    blender = { path: secrets.blender_path || '', available: false, version: '', candidates: [] };
    return;
  }
  const version = await blenderVersion(found.path);
  blender = { path: found.path, available: !!version, version: version || '', candidates: [] };
  log(`blender ${blender.available ? version + ' at ' + blender.path : 'NOT usable at ' + found.path}`);
}

// --------------------------------------------------------------------------- status

function status() {
  const c = providerConfig();
  return {
    ok: true,
    configured: isReady(),
    ai: { enabled: secrets.provider.enabled !== false, base_url: c.base_url, model: c.model, has_key: !!c.key, key_hint: keyHint(c.key), probe: secrets.provider.probe || null },
    allow_blender: secrets.allow_blender !== false,
    blender: { path: blender.path, available: blender.available, version: blender.version, candidates: blender.candidates },
    catalog: catalog.length,
    built: built.size,
    busy: [...jobs.values()].some((j) => j.status === 'running'),
  };
}

// --------------------------------------------------------------------------- jobs

/** @type {Map<string, object>} */
const jobs = new Map();
const KEEP_DONE = 20;

function publicJob(j) {
  return { id: j.id, status: j.status, stage: j.stage, detail: j.detail, progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt, result: j.result, error: j.error };
}

function runJob(id, payload) {
  const job = jobs.get(id);
  const hook = (stage, detail, progress) => {
    if (job.status !== 'running') return;
    job.stage = stage;
    job.detail = detail;
    job.progress = progress;
    log(`job ${id} ${Math.round(progress * 100)}% ${stage} ${detail}`);
  };
  (async () => {
    try {
      const env = {
        ai: { enabled: isReady(), providers: isReady() ? [{ cfg: providerConfig(), label: modelHost() }] : [] },
        B,
        catalog,
        built,
        blender: { available: blender.available, path: blender.path },
        allowBlender: secrets.allow_blender !== false,
        jobDir: path.join(GENERATED, id),
        jobId: id,
        blenderScript: BLENDER_SCRIPT,
        isCancelled: () => job.status !== 'running',
        onBlenderSpawn: (child) => {
          job.child = child;
          if (job.status !== 'running') child.kill();
        },
      };
      const result = await planRegion(payload, env, hook);
      if (job.status !== 'running') return; // cancelled on the way
      job.result = result;
      // what this job built joins the models later regions may reuse
      for (const m of result.models) if (m.jobId === id) built.set(m.id, m);
      job.status = 'done';
      job.stage = 'done';
      job.detail = `「${result.summary.name}」`;
      job.progress = 1;
      log(`job ${id} done: ${result.spec.biome} ${result.summary.sourceLabel} blender=${result.summary.blenderUsed}`);
    } catch (e) {
      if (job.status !== 'running' || e?.message === 'cancelled') {
        if (job.status === 'running') {
          job.status = 'cancelled';
          job.stage = 'cancelled';
          job.detail = '已取消';
        }
        return;
      }
      job.status = 'failed';
      job.stage = 'failed';
      job.error = e?.message || String(e);
      job.detail = `失败：${job.error}`;
      log(`job ${id} failed: ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      // keep only the latest few finished jobs in memory
      const done = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => b.finishedAt - a.finishedAt);
      for (const old of done.slice(KEEP_DONE)) jobs.delete(old.id);
    }
  })();
}

// --------------------------------------------------------------------------- http helpers

function send(res, code, body, headers = {}) {
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' && !Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(text);
}

const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm' };

function serveFile(res, file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return false;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const cache = file.endsWith('index.html') ? 'no-cache' : 'max-age=3600';
  send(res, 200, data, { 'Content-Type': type, 'Cache-Control': cache });
  return true;
}

// --------------------------------------------------------------------------- routes

let B = null;
let catalog = [];

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  const method = req.method;
  if (method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });

  try {
    if (p === '/api/status' && method === 'GET') return json(res, 200, status());

    if (p === '/api/ai/config' && method === 'PUT') {
      const body = await readBody(req);
      const next = secrets.provider;
      if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
      if (typeof body.base_url === 'string') next.base_url = body.base_url.trim().slice(0, 300);
      if (typeof body.model === 'string') next.model = body.model.trim().slice(0, 120);
      if (body.key === null) next.key = '';
      else if (typeof body.key === 'string' && body.key.trim()) next.key = body.key.trim();
      if (typeof body.allow_blender === 'boolean') secrets.allow_blender = body.allow_blender;
      // any edit to what is called invalidates the old test result
      if (body.base_url !== undefined || body.model !== undefined || body.key !== undefined) next.probe = null;
      saveSecrets();
      log(`ai config saved (address ${next.base_url ? 'set' : 'empty'}, model ${next.model || '-'}, key ${next.key ? 'set' : 'none'})`);
      return json(res, 200, status());
    }

    if (p === '/api/ai/test' && method === 'POST') {
      const cfg = providerConfig();
      const missing = !cfg.base_url ? '未填写接口地址' : !cfg.model ? '未填写模型名称' : !cfg.key ? '未填写 API Key' : '';
      if (missing) return json(res, 200, { ok: false, model: cfg.model, latency_ms: 0, message: missing });
      // the same request shape a region uses, with room for a short answer. An empty
      // body still proves the address, the key and the model name (a model may think
      // first); whether it answers properly is what the next region shows.
      const r = await chat(cfg, 'You are a connectivity check. Reply with exactly: OK', 'OK', { maxTokens: 512, temperature: 0, jsonMode: false, timeoutMs: 45000, allowEmpty: true });
      secrets.provider.probe = { ok: r.ok, latency_ms: r.latency_ms, at: new Date().toISOString(), error: r.ok ? undefined : r.error };
      saveSecrets();
      log(`ai test: ${r.ok ? 'ok ' + r.latency_ms + 'ms' : r.error}`);
      return json(res, 200, { ok: r.ok, model: r.model || cfg.model, latency_ms: r.latency_ms, message: r.ok ? (r.text.trim() ? '连接成功' : '已连接，但模型没有返回正文') : r.error });
    }

    if (p === '/api/blender/config' && method === 'GET') return json(res, 200, { ...blender, candidates: blender.candidates });
    if (p === '/api/blender/config' && method === 'PUT') {
      const body = await readBody(req);
      secrets.blender_path = typeof body.path === 'string' ? body.path.trim().slice(0, 400) : '';
      saveSecrets();
      await refreshBlender();
      return json(res, 200, { ...blender, candidates: blender.candidates });
    }

    if (p === '/api/jobs/region' && method === 'POST') {
      if ([...jobs.values()].some((j) => j.status === 'running')) return json(res, 409, { error: '已有一个开拓任务在进行中' });
      const payload = await readBody(req);
      if (!payload || typeof payload !== 'object' || !payload.tile || typeof payload.wish !== 'string') return json(res, 400, { error: '请求缺少 tile 或 wish' });
      if (!Number.isInteger(payload.tile.x) || !Number.isInteger(payload.tile.z) || Math.abs(payload.tile.x) > 200 || Math.abs(payload.tile.z) > 200) return json(res, 400, { error: 'tile 坐标不合法' });
      payload.wish = payload.wish.slice(0, 200);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job = { id, status: 'running', stage: 'queue', detail: '排队中', progress: 0.02, startedAt: Date.now(), finishedAt: 0, result: null, error: null };
      jobs.set(id, job);
      runJob(id, payload);
      return json(res, 200, { job: { id } });
    }

    const jm = /^\/api\/jobs\/([a-z0-9-]+)$/i.exec(p);
    if (jm && method === 'GET') {
      const job = jobs.get(jm[1]);
      if (!job) return json(res, 404, { error: '找不到这个任务' });
      return json(res, 200, publicJob(job));
    }
    if (jm && method === 'DELETE') {
      const job = jobs.get(jm[1]);
      if (job && job.status === 'running') {
        try {
          job.child?.kill();
        } catch {
          /* already gone */
        }
        job.status = 'cancelled';
        job.stage = 'cancelled';
        job.detail = '已取消';
        job.finishedAt = Date.now();
        log(`job ${jm[1]} cancelled`);
      }
      return json(res, 200, { ok: true });
    }

    // runtime/generated/<job>/recipes.json and runtime/generated/<job>/models/<id>.glb
    const gm = /^\/generated\/([a-z0-9-]+)\/(?:models\/)?([a-z0-9_.-]+\.(glb|json|bin))$/i.exec(p);
    if (gm && method === 'GET') {
      const file = path.join(GENERATED, gm[1], p.toLowerCase().includes('/models/') ? 'models' : '', gm[2]);
      if (!file.startsWith(GENERATED + path.sep)) return json(res, 403, { error: 'forbidden' });
      return serveFile(res, file) || json(res, 404, { error: 'not found' });
    }

    if (STATIC_DIR && method === 'GET' && !p.startsWith('/api/')) {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.normalize(path.join(STATIC_DIR, rel));
      if (!file.startsWith(STATIC_DIR)) return json(res, 403, { error: 'forbidden' });
      if (serveFile(res, file)) return;
      return serveFile(res, path.join(STATIC_DIR, 'index.html')) || json(res, 404, { error: 'not found' });
    }

    return json(res, 404, { error: `no route for ${method} ${p}` });
  } catch (e) {
    log(`error ${method} ${p}: ${e?.stack || e}`);
    return json(res, 500, { error: e?.message || String(e) });
  }
}

// --------------------------------------------------------------------------- start

B = await loadBiomes();
catalog = loadCatalog();
await refreshBlender();
if (!blender.available && !secrets.blender_path) {
  log('hint: set the Blender path in 设置 → 模型与 AI, or put blender.exe in a standard install folder');
}
loadBuilt();
log(`catalog: ${catalog.length} prefab models, ${built.size} built for regions so far; biomes: ${B.BIOME_ORDER.join(', ')}`);
if (!fs.existsSync(SECRETS)) log(`no AI configured yet — regions fall back to the local recipe (keys go to ${SECRETS})`);

const server = http.createServer((req, res) => {
  handle(req, res);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Mist Isles server on http://127.0.0.1:${PORT}${STATIC_DIR ? ` serving ${STATIC_DIR}` : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, stopping`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}
