/**
 * Client for the game's local server: the AI endpoint settings, Blender status and
 * region jobs. The server is the only thing that talks to a language model — the
 * browser never sees an API key.
 */
import type { BiomeId, TileSpec } from './world';
import type { ModelEntry } from './assets';

/** The one endpoint the player configures. The key itself never leaves the server. */
export interface AiInfo {
  enabled: boolean;
  base_url: string;
  model: string;
  has_key: boolean;
  /** last four characters, so the settings page can show which key is stored */
  key_hint: string;
  probe: { ok: boolean; latency_ms: number; at: string; error?: string } | null;
}

export interface BlenderInfo {
  path: string;
  available: boolean;
  version: string;
  candidates: string[];
}

export interface StatusInfo {
  ok: boolean;
  /** the endpoint can be called right now: address, model name and key are all set */
  configured: boolean;
  ai: AiInfo;
  allow_blender: boolean;
  blender: BlenderInfo;
  catalog: number;
  /** models Blender has built for regions so far */
  built: number;
  busy: boolean;
}

export interface RegionResult {
  spec: TileSpec;
  models: (ModelEntry & { url: string })[];
  summary: { name: string; extent: number; sourceLabel: string; biome: BiomeId; blenderUsed: boolean; notes: string[] };
}

export interface JobInfo {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  detail: string;
  progress: number;
  startedAt: number;
  result?: RegionResult;
  error?: string;
}

export interface RegionPayload {
  wish: string;
  seed: number;
  tile: { x: number; z: number };
  /** what the tile will be like once opened: the mist hides it, the climate has decided it */
  climate: { temp: number; moist: number; biome: BiomeId; land: boolean; peak: number };
  context: {
    neighbours: { x: number; z: number; rel: string; biome: BiomeId; name: string; source: string; models: string[]; peak: number; land: number; feature: string }[];
    nearbyModels: string[];
    player: { x: number; z: number };
  };
}

export interface AiConfigPatch {
  base_url?: string;
  model?: string;
  /** an empty string keeps the stored key; null removes it */
  key?: string | null;
  enabled?: boolean;
  allow_blender?: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = (data as { error?: string } | null)?.error || `${res.status} ${res.statusText}`;
    throw new Error(err);
  }
  return data as T;
}

export const aiApi = {
  status: () => call<StatusInfo>('GET', '/api/status'),
  saveConfig: (patch: AiConfigPatch) => call<StatusInfo>('PUT', '/api/ai/config', patch),
  test: () => call<{ ok: boolean; model: string; latency_ms: number; message: string }>('POST', '/api/ai/test'),
  blender: () => call<BlenderInfo>('GET', '/api/blender/config'),
  setBlender: (path: string) => call<BlenderInfo>('PUT', '/api/blender/config', { path }),
  startRegion: (payload: RegionPayload) => call<{ job: { id: string } }>('POST', '/api/jobs/region', payload),
  job: (id: string) => call<JobInfo>('GET', `/api/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => call<{ ok: boolean }>('DELETE', `/api/jobs/${encodeURIComponent(id)}`),
};

export const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
