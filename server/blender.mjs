/**
 * Blender as an offline asset generator for the game server: find the executable,
 * ask its version, run one build script in the background with a time limit.
 * Blender is never shown to the player and never keeps a window open.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION_CACHE = new Map();

/** Common install locations on Windows, macOS and Linux. */
function candidateExecutables() {
  const out = [];
  if (process.env.BLENDER_PATH) out.push(process.env.BLENDER_PATH);
  const roots = [
    'C:/Program Files/Blender Foundation',
    'D:/Program Files/Blender Foundation',
    'E:/Program Files/Blender Foundation',
    'C:/Program Files',
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    '/Applications',
    '/usr/bin',
    '/usr/local/bin',
    '/snap/bin',
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    if (/blender(\.exe)?$/i.test(root)) {
      out.push(root);
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/^blender/i.test(e)) continue;
      const full = path.join(root, e);
      if (fs.statSync(full).isDirectory()) {
        for (const exe of ['blender.exe', 'blender', 'Contents/MacOS/Blender']) {
          const p = path.join(full, exe);
          if (fs.existsSync(p)) out.push(p);
        }
      } else if (/^blender(\.exe)?$/i.test(e)) out.push(full);
    }
  }
  // newest version first ("Blender 4.3" before "Blender 3.6")
  return [...new Set(out)].sort((a, b) => (b.match(/(\d+)\.(\d+)/) || [0, 0]).join('.').localeCompare((a.match(/(\d+)\.(\d+)/) || [0, 0]).join('.'), undefined, { numeric: true }));
}

/**
 * @param {string} explicit  a path the user typed in the settings (may be empty)
 * @returns {{path: string, available: boolean, version: string}|null}
 */
export function findBlender(explicit = '') {
  const list = explicit ? [explicit, ...candidateExecutables()] : candidateExecutables();
  for (const p of list) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return { path: p, available: true, version: '' };
  }
  return null;
}

/** Runs `blender --version` style probe in background mode; cached per executable. */
export async function blenderVersion(exe) {
  if (VERSION_CACHE.has(exe)) return VERSION_CACHE.get(exe);
  const v = await new Promise((resolve) => {
    try {
      const child = spawn(exe, ['-b', '--factory-startup', '--python-exit-code', '1', '--python-expr', "import bpy; print('MIST_VERSION', bpy.app.version_string)"], { windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 60000);
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/MIST_VERSION\s+(\S+)/);
        resolve(m ? m[1] : /Blender\s+(\d+\.\d+[.\d]*)/.exec(out)?.[1] || null);
      });
    } catch {
      resolve(null);
    }
  });
  VERSION_CACHE.set(exe, v);
  return v;
}

/**
 * Runs one Blender Python script headless.
 * The script reports progress by printing lines `MIST_PROGRESS <0..1> <text>`.
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean, log: string}>}
 */
export function runBlenderScript(exe, script, args = [], { timeoutMs = 240000, onProgress = () => {}, onSpawn = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let timedOut = false;
    try {
      onSpawn(child); // lets the caller kill a cancelled job
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const take = (chunk) => {
      const text = String(chunk);
      log += text;
      for (const line of text.split(/\r?\n/)) {
        const m = /MIST_PROGRESS\s+([\d.]+)\s*(.*)/.exec(line);
        if (m) {
          try {
            onProgress(Math.max(0, Math.min(1, Number(m[1]))), m[2].trim());
          } catch {
            /* a progress callback must never break the job */
          }
        }
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, log: log + `\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, timedOut, log });
    });
  });
}
