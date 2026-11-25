/**
 * Dev launcher: starts the local game server (AI + Blender jobs) and Vite, and
 * takes both down together.   npm run dev
 *
 *   game      http://127.0.0.1:5173/     (Vite, proxies /api and /generated)
 *   server    http://127.0.0.1:8787/     (runtime/secrets.json holds the AI keys)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '..');
const port = process.env.PORT || '8787';

const kids = [];
function run(name, args, opts = {}) {
  const child = spawn(process.execPath, args, { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  kids.push(child);
  const prefix = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code || 0);
  });
  return child;
}

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const c of kids) {
    if (!c.killed) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(code), 300);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}

run('api', [path.join(root, 'server', 'index.mjs')], { env: { ...process.env, PORT: port } });
run('vite', [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort', '--host', '127.0.0.1']);
console.log('\n  迷雾群岛  →  http://127.0.0.1:5173/\n');
