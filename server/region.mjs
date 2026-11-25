/**
 * Region planning: turn "the player wishes for the tile in front of them" into a
 * validated region card, plus any model Blender has to build for it.
 *
 *   AI card      — the configured language model reads the neighbouring tiles,
 *                  the models standing nearby and the wish, and answers with JSON.
 *   Local recipe — no AI configured, or every provider failed: a deterministic
 *                  card built from the same surroundings. Never random noise, and
 *                  the summary says plainly that it was not the AI.
 *
 * Nothing the model writes reaches the game unchecked: every field is clamped,
 * unknown props are dropped, the biome must fit the neighbourhood, and a new
 * model is only built when Blender is actually available and allowed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chat, extractJson } from './ai.mjs';
import { runBlenderScript } from './blender.mjs';

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const FEATURES = new Set(['none', 'volcano', 'peak', 'crater', 'pond']);

function hashStr(s) {
  return parseInt(crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12), 16) >>> 0;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Placement defaults per model kind, shared by AI cards and local recipes. */
export function ruleFor(model, kind, n, landmark = false) {
  const base = { model, n: landmark ? 1 : Math.round(clamp(n, 1, 90, 5)), landmark: !!landmark };
  if (landmark) return { ...base, minH: 1.4, maxSlope: 0.3, spacing: 9 };
  switch (kind) {
    case 'tree':
      return { ...base, minH: 1.2, maxSlope: 0.46, spacing: 3.6 };
    case 'rock':
      return { ...base, minH: 0.8, maxSlope: 0.92, spacing: 3 };
    case 'shrub':
      return { ...base, minH: 0.9, maxSlope: 0.5, spacing: 2.4 };
    case 'plant':
      return { ...base, minH: 0.6, maxSlope: 0.7, spacing: 1.0, cluster: -0.2 };
    default:
      return { ...base, minH: 0.5, maxSlope: 0.6, spacing: 1.3 };
  }
}

// --------------------------------------------------------------------------- prompt

const PART_DOC = [
  'tree 阔叶树 {"type":"tree","h":4.5,"r0":0.34,"bend":[0.3,-0.2],"roots":{"n":4,"len":0.9},"branches":{"n":5,"len":[1,1.6],"rise":[0.4,0.9]},"canopy":{"size":[3.9,2.5,3.9],"lobes":6,"noise":0.17,"tris":700,"paint":{..}}}',
  'bush 灌木 {"type":"bush","size":[1.8,1.3,1.8],"lobes":4,"twigs":3,"noise":0.2,"paint":{..}}（贴地成团的叶子；上面可再加 coat 开花）',
  'roots 根爪 {"type":"roots","n":4,"len":0.9,"r":0.2,"at":[0,0,0]}（单独给树脚补板根）',
  'pine 针叶树 {"type":"pine","h":6,"radius":1.7,"layers":4,"snow":true,"needles":{..}}',
  'mushroom 菌类 {"type":"mushroom","h":2,"capR":1.1,"capH":0.7,"glow":true,"spots":5,"ring":true,"cap":{..},"gill":{..}}',
  'cactus 仙人掌 {"type":"cactus","h":2.4,"r":0.32,"ribs":7,"arms":[[1,0.42,2.0,2.6]],"spines":true,"flower":{"size":[0.4,0.25,0.4],"paint":{..}}}',
  'palm 棕榈/椰树 {"type":"palm","h":6,"lean":[1.5,0.5],"fronds":9,"frondLen":2.7,"leaflets":18,"coconuts":3}',
  'coral 分叉珊瑚 {"type":"coral","fingers":8,"h":1,"r":0.09}',
  'crystal 晶簇 {"type":"crystal","h":2,"shards":5,"sides":5,"glow":false}',
  'flower 小花 {"type":"flower","h":0.45,"petal":"#fdf6e2","core":"#e8c06e","petals":5}',
  'arch 拱门 {"type":"arch","span":5.4,"rise":5.8,"thick":1.2}',
  'canopy 团状块（树冠/灌丛/脑珊瑚）{"type":"canopy","at":[0,3,0],"size":[3,2,3],"lobes":5,"noise":0.15,"tris":600}',
  'rock 切面岩石 {"type":"rock","style":"boulder|angular|slab","at":[0,0,0],"size":[1.5,1,1.3],"points":20,"noise":0.24}',
  'limb 弯管（树干/枝/柱）{"type":"limb","path":[[0,0,0],[0.2,2,0],[0.5,4,0]],"radii":[0.4,0.25,0.1],"sides":8}',
  'loft 放样体（塔/锥/柱/台）{"type":"loft","at":[0,0,0],"sides":8,"rings":[{"y":0,"r":1},{"y":2,"r":0.5},{"y":3,"r":0}]}',
  'tuft 草丛/芦苇 {"type":"tuft","n":14,"len":[0.3,0.5],"w":[0.02,0.03]}（芦苇加 "leafW":3,"leafShare":0.4,"heads":3,"plumes":1,"stem":[1.3,1.6]）',
  'frond 羽叶 {"type":"frond","len":2,"leaflets":16}',
  'blade 叶片 {"type":"blade","len":0.6,"w":0.1,"bend":40,"tilt":30,"yaw":0}',
  'curtain 垂帘（柳枝）{"type":"curtain","n":16,"len":[1,2]}',
  'spikes 尖刺 {"type":"spikes","n":40,"r":[0.3,0.26],"y":[0.1,2],"len":0.12}',
];

function paintDoc() {
  return 'paint 颜色 {"color":"#rrggbb","color2":"#rrggbb","under":"#rrggbb","mode":"uniform|height|normal|bands","jitter":0.05,"coat":{"color":"#rrggbb","t0":0.5,"amount":0.7}}；' +
    '"at":[x,y,z] 位置、"rot":[rx,ry,rz] 角度、"scale":倍率、"glow":true 让该部件发光。坐标 Y 向上，单位 BU：史莱姆约 1 BU 高，树 3–7 BU，地标 6–10 BU。';
}

/** Where a biome sits in the climate, in two words for the prompt. */
function climateWords(b) {
  const heat = b.temp < 0.3 ? '寒冷' : b.temp < 0.7 ? '温和' : '炎热';
  const rain = b.moist < 0.3 ? '干燥' : b.moist < 0.7 ? '适中' : '潮湿';
  return `${heat}、${rain}`;
}

/** "forest 苍郁林地：起伏的密林……" — an id means nothing to a language model on its own. */
function describeBiome(B, id) {
  const b = B.BIOMES[id];
  return b ? `${id} ${b.label}（${climateWords(b)}）：${b.blurb}` : String(id);
}

export function systemPrompt(B, catalog, compact, built = []) {
  const biomeLines = B.BIOME_ORDER.map((id) => describeBiome(B, id)).join('\n');
  const neighLines = B.BIOME_ORDER.map((id) => `${id} → ${B.BIOME_NEIGHBOURS[id].join('/')}`).join('；');
  const cat = compact
    ? catalog.map((m) => `${m.id}(${m.kind})`).join(', ')
    : catalog.map((m) => `${m.id} ${m.label}·${m.kind}：${m.desc}`).join('\n');
  return `你是开放世界游戏《迷雾群岛》的世界设计师。玩家站在已知世界的边缘，面前是一块还没开拓的 40×40 格子，藏在迷雾里。请读这块格子的自然条件、相邻格子的情况、附近已有的模型和玩家的愿望，为它设计一个新区域。新区域必须像"同一个世界的另一角"，不能是另一个世界。

【群系】每个群系是一种气候：
${biomeLines}
【气候是连续的】整片大地的气候随位置慢慢变化（越往北越冷），森林会先变成草原、再渐渐变成荒漠，中间没有明确的界线。"目标格子的自然条件"写明了它本来的样子——迷雾只是挡住了视线，那里的地貌早已由气候决定。默认顺其自然：biome 就取自然群系，地势顺势延续，植被由气候自己长出来。愿望留空时完全顺其自然：给这里起个名字、写一句氛围就够了，最多加一两样点睛之物。
只有当玩家的愿望明确要另一种地貌时才改成别的群系，而且必须是相邻格子的群系或它们的邻居——它会在格子中央最浓，向四周渐渐变回去。本来是海的格子默认还是海（浅海、潟湖或沙洲）。
【相邻关系】${neighLines}
【地势】peak（峰高）一般省略不写；确实要抬高或压低地势时才写，并且和自然条件给出的大致峰高相差不超过 ±40%。想要一座突起的山、火山口、陨石坑或池塘，用 feature，不要用 peak 硬堆。rough、land 同样可省略；land 只在要造潟湖、沙洲或把海填成陆地时才写。

【现有模型库】（props 里的 model 从这里选，或新建模型）
${cat}
${built.length ? `\n【之前为别的区域新造的模型】（同样可以直接用 id）\n${built.map((m) => (compact ? `${m.id}(${m.kind})` : `${m.id} ${m.label}·${m.kind}：${m.desc}`)).join(compact ? ', ' : '\n')}\n` : ''}

【props 是点睛，不是清单】这块地上的树、草、花由气候自己长出来，不需要你罗列。props 只写要在自然植被之外额外添加的东西：地标、新造的模型、愿望特别要求的东西。顺其自然时给空数组。
【什么时候需要 Blender】只有当这个区域的设想需要模型库里没有的东西时，才新建模型（needs_blender=true）。新建的模型用"部件配方"描述，由 Blender 在后台建模（约 10–40 秒）。最多 2 个新模型，每个最多 8 个部件。能组合现有模型达到效果时，不要新建。
部件类型与参数：
${PART_DOC.join('\n')}
${paintDoc()}

【多大的一块地】先想清楚这个区域需要多大的地方，再回答 "extent"：这一片地貌该占几个格子（1–3，每个 40×40）。默认 1——多数地貌一个格子就够。只有一种地方大到一格放不下时才写 2 或 3：一条大山脊、一圈环礁、一片要好几格才圆的湖、一整座火山带。如果你依据愿望设计了某样东西需要 2–3 格，就写在 extent 里，并在 "extent_why" 用一句话说明为什么一格不够。相邻的格子会沿用同一份设定（同样的地貌、地势与植被），所以放不下的东西可以放心说大。

【输出】只输出一个 JSON 对象，不要任何解释或 Markdown。标了"可省略"的字段，没有需要就不要写：
{
 "name": "2–8 个字的区域名",
 "extent": 1|2|3（这片地貌需要几个格子，默认 1）,
 "extent_why": "为什么一格不够（extent>1 时写，一句话）",
 "biome": "目标格子的自然群系（见自然条件里的英文 id）",
 "mood": "一句话的氛围",
 "desc": "80 字以内的描述",
 "peak": 峰高，可省略,
 "rough": 0–1，可省略,
 "land": 0.15–1 陆地占比，可省略,
 "feature": "none|volcano|peak|crater|pond",
 "accent": "#rrggbb"（地面色调的轻微倾向），可省略,
 "props": [{"model":"模型库 id 或新模型 id","n":1–60,"landmark":false}]（0–4 条，可以是空数组）,
 "needs_blender": true|false,
 "new_models": [{"id":"小写字母数字下划线","label":"中文名","kind":"tree|shrub|rock|plant|detail|landmark","desc":"一句话","fallback":"模型库里最接近的 id","parts":[部件...]}]
}
landmark 最多 1 个。`;
}

// --------------------------------------------------------------------------- validation

function allowedBiomes(neighbourBiomes, B, natural) {
  const set = new Set(neighbourBiomes.filter((b) => B.BIOMES[b]));
  // what the climate here gives anyway needs no neighbour's permission, and neither
  // do the climates it fades into on either side
  if (natural && B.BIOMES[natural]) {
    set.add(natural);
    for (const n of B.BIOME_NEIGHBOURS[natural] || []) set.add(n);
  }
  for (const b of neighbourBiomes) for (const n of B.BIOME_NEIGHBOURS[b] || []) set.add(n);
  return set;
}

/** same normalisation a new model's id goes through */
function cleanId(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function cleanName(name, fallback) {
  const s = String(name ?? '')
    .replace(/[《》「」“”"'/\\{}\[\]<>|*?:\n\r\t]/g, '')
    .replace(/\s+/g, '')
    .trim();
  return s.slice(0, 12) || fallback;
}

/**
 * Clamps a raw card into a legal one. `notes` collects every correction so the
 * summary can be honest about what the AI got wrong.
 *
 * A card that keeps the natural biome only steers what it clearly asks for: a peak
 * that differs from the natural one, a feature, a tint, its additions. A card that
 * chooses another biome steers the whole core of the tile towards it.
 */
export function validateCard(raw, ctx) {
  const { B, catalog, neighbourBiomes, neighbourPeaks, built } = ctx;
  const natural = ctx.natural && B.BIOMES[ctx.natural] ? ctx.natural : undefined;
  const notes = [];
  const card = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  let biome = String(card.biome ?? '');
  const allowed = allowedBiomes(neighbourBiomes, B, natural);
  if (!B.BIOMES[biome] || !allowed.has(biome)) {
    const was = biome;
    // back to what the climate makes of this place, or the first neighbour that exists
    biome = natural ?? neighbourBiomes.find((b) => B.BIOMES[b]) ?? 'meadow';
    notes.push(was && B.BIOMES[was] ? `群系「${B.BIOMES[was].label}」与周围不接壤，已改回自然的「${B.BIOMES[biome].label}」` : '没有给出群系，已按自然条件决定');
  }
  out.biome = biome;
  const follows = biome === natural;
  out.name = cleanName(card.name, B.BIOMES[biome].label);
  // how much land this country needs, in tiles; the browser opens the rest of them
  // with the same card, so a ridge or a ring of reef can be larger than one tile
  const ext = Number.isFinite(+card.extent) ? Math.round(+card.extent) : 1;
  out.extent = Math.max(1, Math.min(3, ext));
  if (ext > 3) notes.push('区域范围超过 3 格，已按 3 格处理');
  out.extent_why = String(card.extent_why ?? '').slice(0, 80);
  out.mood = String(card.mood ?? '').slice(0, 60);
  out.desc = String(card.desc ?? '').slice(0, 160);

  const def = B.BIOMES[biome];
  // what the land wants to be here, as the browser measured it; else what the tiles around are
  const refPeak = ctx.naturalPeak > 0 ? ctx.naturalPeak : neighbourPeaks.length ? neighbourPeaks.reduce((a, b) => a + b, 0) / neighbourPeaks.length : def.peak;
  let peak = clamp(card.peak, 1, 22, refPeak);
  if (card.peak !== undefined && (!follows || (ctx.wish && Math.abs(peak - refPeak) >= refPeak * 0.15))) {
    const lim = [refPeak * 0.6, refPeak * 1.4];
    if (peak < lim[0] || peak > lim[1]) {
      notes.push(`峰高 ${peak} 和这一带相差超过 ±40%，已限制为 ${clamp(peak, lim[0], lim[1], def.peak).toFixed(1)}`);
      peak = clamp(peak, lim[0], lim[1], def.peak);
    }
  }
  // following the climate: a peak that is merely the natural one written down steers
  // nothing, and with no wish at all the land is left exactly as it is
  const asked = ctx.wish && Math.abs(peak - refPeak) >= refPeak * 0.15;
  out.peak = card.peak === undefined || (follows && !asked) ? undefined : +peak.toFixed(2);
  out.rough = follows || card.rough === undefined ? undefined : +clamp(card.rough, 0.05, 1, def.rough).toFixed(3);
  out.land = follows || card.land === undefined ? undefined : +clamp(card.land, 0.15, 1, def.land).toFixed(3);
  const feature = FEATURES.has(card.feature) && card.feature !== 'none' ? card.feature : undefined;
  if (card.feature !== undefined && !FEATURES.has(card.feature)) notes.push(`未知地形特征「${card.feature}」已忽略`);
  out.feature = feature ?? (follows ? undefined : def.feature);
  out.accent = /^#[0-9a-f]{6}$/i.test(String(card.accent ?? '')) ? String(card.accent).toLowerCase() : undefined;

  // new models: at most two, sane ids, each with a parts list
  const rawNew = Array.isArray(card.new_models) ? card.new_models : [];
  const models = [];
  // a new model never hides behind the id of one that already exists
  const seen = new Set([...catalog.map((c) => c.id), ...(built?.keys() ?? [])]);
  const rawToClean = new Map();
  for (const m of rawNew.slice(0, 2)) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.parts) || !m.parts.length) {
      notes.push('一个新模型缺少部件，已忽略');
      continue;
    }
    const clean = cleanId(m.id);
    let id = clean;
    if (!ID_RE.test(id)) id = `new_${models.length + 1}_${hashStr(JSON.stringify(m.parts)) % 997}`;
    if (seen.has(id)) {
      let v = 2;
      while (seen.has(`${id.slice(0, 27)}_v${v}`)) v++;
      id = `${id.slice(0, 27)}_v${v}`;
    }
    seen.add(id);
    // whatever the model called it, props that use that spelling must find it
    rawToClean.set(cleanId(m.id), id);
    rawToClean.set(String(m.id ?? '').trim().toLowerCase(), id);
    models.push({
      id,
      label: String(m.label ?? id).slice(0, 24),
      kind: ['tree', 'shrub', 'rock', 'plant', 'detail', 'landmark'].includes(m.kind) ? m.kind : 'detail',
      desc: String(m.desc ?? '').slice(0, 120),
      fallback: catalog.some((c) => c.id === m.fallback) ? m.fallback : undefined,
      parts: m.parts.slice(0, 8),
    });
  }
  if (rawNew.length > 2) notes.push('新模型超过 2 个，只保留前 2 个');

  // props: only models that exist in the library or are being built
  const catKind = new Map(catalog.map((c) => [c.id, c.kind]));
  const newKind = new Map(models.map((m) => [m.id, m.kind]));
  const props = [];
  let landmark = 0;
  // additions on top of what the climate grows: kept few, so no tile stands out as a block
  for (const p of Array.isArray(card.props) ? card.props.slice(0, 8) : []) {
    if (!p || typeof p !== 'object') continue;
    const asked = String(p.model ?? '');
    const id = rawToClean.get(asked.trim().toLowerCase()) ?? rawToClean.get(cleanId(asked)) ?? asked;
    const isLandmark = !!p.landmark;
    if (isLandmark && landmark >= 1) {
      notes.push('地标最多 1 个，多余的已去掉');
      continue;
    }
    if (catKind.has(id)) {
      const kind = catKind.get(id);
      if (isLandmark && !['landmark', 'tree', 'rock'].includes(kind)) continue;
      props.push(ruleFor(id, kind, p.n, isLandmark || kind === 'landmark'));
      if (isLandmark || kind === 'landmark') landmark++;
    } else if (newKind.has(id)) {
      props.push(ruleFor(id, newKind.get(id), p.n, isLandmark));
      if (isLandmark) landmark++;
    } else if (built?.has(id)) {
      // built for an earlier region and still on disk: no Blender run needed
      const kind = built.get(id).kind;
      props.push(ruleFor(id, kind, p.n, isLandmark || kind === 'landmark'));
      if (isLandmark || kind === 'landmark') landmark++;
    } else {
      notes.push(`模型「${id.slice(0, 40)}」不在模型库里，已忽略`);
    }
  }
  out.props = props;
  out.new_models = models;
  out.needs_blender = card.needs_blender === true && models.length > 0;
  return { card: out, notes };
}

/** Fills a card whose new models could not be built with the closest library model. */
function replaceMissing(card, builtIds, catalog, notes) {
  const cat = new Set(catalog.map((c) => c.id));
  const missing = card.new_models.filter((m) => !builtIds.has(m.id));
  if (!missing.length) return;
  for (const m of missing) {
    const sub = cat.has(m.fallback) ? m.fallback : undefined;
    notes.push(`Blender 没能建出「${m.label}」${sub ? `，已用模型库里的「${sub}」代替` : '，相关植被已去掉'}`);
    for (const p of card.props) {
      if (p.model !== m.id) continue;
      if (sub) p.model = sub;
      else p.n = 0;
    }
  }
  card.props = card.props.filter((p) => p.n > 0);
  card.new_models = card.new_models.filter((m) => builtIds.has(m.id));
  card.needs_blender = false;
}

// --------------------------------------------------------------------------- local recipe

const WISH_KEYWORDS = [
  [/雪|冰|霜|寒|冻/, 'snow'],
  [/火|熔岩|岩浆|黑曜|灰烬|焦/, 'volcanic'],
  [/沼|泽|湿地|泥|菌|蘑菇|芦苇/, 'swamp'],
  [/沙滩|海岸|椰|棕榈|贝壳|海星/, 'beach'],
  [/海|礁|珊瑚|泻湖|潟湖|浅水|环礁/, 'ocean'],
  [/花|樱|粉|桃/, 'meadow'],
  [/林|树|森|木|果/, 'forest'],
  [/草|原|丘|牧场|风/, 'meadow'],
  [/沙|漠|仙人掌|绿洲/, 'desert'],
];

const NAMES = {
  meadow: ['野花坡', '风息草甸', '金雀原', '牧云丘', '絮风坪'],
  forest: ['雾杉谷', '古木林', '灯苔林', '翠影坡', '回声林'],
  snow: ['冰晶原', '雪松岭', '蓝雪谷', '霜牙脊', '静雪坡'],
  desert: ['鸣沙丘', '赤岩台', '仙人掌谷', '风蚀碑原', '流金沙海'],
  swamp: ['灯菌沼', '芦苇荡', '静水洼', '沉雾泽', '蟾鸣泽'],
  volcanic: ['黑曜崖', '熔渣原', '焦木岭', '余烬坡', '烟喉谷'],
  beach: ['椰影湾', '拾贝岸', '潮白滩', '听涛沙嘴'],
  ocean: ['碧礁湖', '浅沙洲', '珊瑚湾', '环礁心'],
};

/**
 * Deterministic card for when no language model answered: what the climate makes
 * of the place, named after it, with the vegetation left to the climate. A wish
 * that names another kind of country steers the tile towards it when the
 * neighbourhood allows.
 */
export function localRecipe(payload, B) {
  const { wish = '', seed = 0, tile, context } = payload;
  const climate = payload.climate ?? context?.climate;
  const rnd = mulberry32(hashStr(`${seed}|${tile.x}|${tile.z}|${wish}`));
  const natural = climate?.biome;
  const neighbourBiomes = [...new Set((context?.neighbours ?? []).map((n) => n.biome).filter((b) => B.BIOMES[b]))];
  const allowed = allowedBiomes(neighbourBiomes.length ? neighbourBiomes : natural ? [natural] : ['meadow'], B, natural);

  let biome = null;
  for (const [re, b] of WISH_KEYWORDS) {
    if (re.test(wish) && allowed.has(b)) {
      biome = b;
      break;
    }
  }
  const steered = biome !== null && biome !== natural;
  if (!biome) biome = natural && B.BIOMES[natural] ? natural : neighbourBiomes[0] ?? 'meadow';
  const def = B.BIOMES[biome];
  const basePeak = climate?.peak > 0 ? climate.peak : def.peak;
  const peaks = (context?.neighbours ?? []).map((n) => n.peak).filter((p) => p > 0);
  const refPeak = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : basePeak;
  const peak = +clamp(basePeak * (0.92 + rnd() * 0.16), refPeak * 0.6, refPeak * 1.4, def.peak).toFixed(2);
  const names = NAMES[biome] || [def.label];
  const moods = {
    meadow: '风从草尖上滑过去，没有一点声音',
    forest: '树冠把光筛成一地碎银',
    snow: '呼出的气还没散开就结成了霜',
    desert: '风把昨天的脚印抹掉了',
    swamp: '水面是温的，但没人想下去',
    volcanic: '山睡着了，石头还温着',
    beach: '潮水一遍遍数着沙滩上的脚印',
    ocean: '水浅得能看见每一道沙纹',
  };
  const accent = { meadow: '#b9d98a', forest: '#6fae55', snow: '#eaf3fb', desert: '#e6cf98', swamp: '#7f9452', volcanic: '#5b5a63', beach: '#f0e0b4', ocean: '#bfe9e2' }[biome];
  return {
    card: {
      name: steered ? names[Math.floor(rnd() * names.length)] : '',
      biome,
      mood: moods[biome],
      desc: def.blurb,
      peak: steered ? peak : undefined,
      rough: undefined,
      land: steered && (biome === 'ocean' || biome === 'beach') ? def.land : undefined,
      feature: undefined,
      accent: steered ? accent : undefined,
      props: [],
      needs_blender: false,
      new_models: [],
      extent: 1,
    },
    notes: [],
  };
}

// --------------------------------------------------------------------------- orchestrator

/**
 * @param {object} payload  what the browser sent (wish, seed, tile, context)
 * @param {object} env
 *   ai: { providers: [{cfg, label}], enabled }   configured providers, active first
 *   B: bundled biome tables, catalog: model catalog
 *   blender: { available, path }, allowBlender: boolean
 *   jobDir: directory for this job, blenderScript: path of build_recipe.py
 * @param {(stage:string, detail:string, progress:number)=>void} hook
 */
export async function planRegion(payload, env, hook = () => {}) {
  const { B, catalog } = env;
  const notes = [];
  const neighbourBiomes = [...new Set((payload.context?.neighbours ?? []).map((n) => n.biome))];
  // the peaks of the tiles around, as the browser measured them
  const neighbourPeaks = (payload.context?.neighbours ?? []).map((n) => n.peak).filter((p) => p > 0);
  const known = env.built ?? new Map();
  // what the climate has decided for this tile before anyone opened it
  const climate = payload.climate ?? payload.context?.climate ?? {};
  const natural = climate.biome && B.BIOMES[climate.biome] ? climate.biome : undefined;
  const ctx = { B, catalog, neighbourBiomes, neighbourPeaks, built: known, natural, naturalPeak: Number(climate.peak) || 0, wish: !!String(payload.wish ?? '').trim() };

  hook('queue', '已收到开拓请求', 0.03);

  // ---- AI card (active provider first, then one fallback provider)
  let card = null;
  let provider = null;
  const tried = [];
  if (env.ai?.enabled && env.ai.providers.length) {
    for (const p of env.ai.providers.slice(0, 2)) {
      hook('ai', `正在让 ${p.label} 构思新区域…`, 0.08);
      const compact = p.cfg.id === 'ollama';
      // an id means nothing to a language model: say what each nearby model is
      const describe = (id) => {
        const c = known.get(id) ?? catalog.find((m) => m.id === id);
        return c?.label ? `${id}（${c.label}·${c.kind}）` : id;
      };
      const c = climate;
      const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined);
      const user = JSON.stringify({
        玩家的愿望: payload.wish || '（留空：请根据周围环境自行决定）',
        目标格子: payload.tile,
        目标格子的自然条件: {
          温度: round(c.temp, 2),
          湿度: round(c.moist, 2),
          自然群系: c.biome ? describeBiome(B, c.biome) : undefined,
          本来是: c.land === undefined ? undefined : c.land ? '陆地' : '海',
          大致峰高: round(c.peak, 1),
        },
        相邻的已开拓格子: (payload.context?.neighbours ?? []).map((n) => ({
          位置: n.rel,
          群系: describeBiome(B, n.biome),
          名字: n.name,
          峰高: n.peak,
          陆地占比: n.land,
          地形特征: n.feature,
          植被: (n.models ?? []).map(describe),
        })),
        附近已有的模型: (payload.context?.nearbyModels ?? []).map(describe),
        Blender可用: !!(env.allowBlender && env.blender.available),
      });
      // a card with two new models of eight parts each is about 1,500 tokens of JSON
      const r = await chat(p.cfg, systemPrompt(B, catalog, compact, [...known.values()]), user, { maxTokens: 3000, temperature: 0.8, timeoutMs: 75000 });
      if (!r.ok) {
        tried.push(`${p.label}：${r.error}`);
        continue;
      }
      const raw = extractJson(r.text);
      if (!raw) {
        tried.push(`${p.label}：回复里没有可用的 JSON`);
        continue;
      }
      const v = validateCard(raw, ctx);
      card = v.card;
      notes.push(...v.notes);
      provider = p.label;
      if (r.truncated) notes.push('模型回复被截断，已按已返回的部分处理');
      break;
    }
    if (!card) notes.push(`AI 未能给出区域卡（${tried.join('；')}），改用本地配方`);
  }

  // ---- local recipe
  if (!card) {
    hook('ai', '按周围环境推演新区域…', 0.12);
    const r = localRecipe(payload, B);
    card = r.card;
    notes.push(...r.notes);
    provider = null;
  }
  hook('export', '区域设定已就绪', 0.4);

  // ---- Blender for what the library does not have
  let models = [];
  let blenderUsed = false;
  const wantBlender = card.needs_blender && card.new_models.length > 0;
  if (wantBlender && !(env.allowBlender && env.blender.available)) {
    notes.push(env.allowBlender ? '没有找到 Blender，新模型改用模型库里最接近的' : '设置里关闭了 Blender，新模型改用模型库里最接近的');
    replaceMissing(card, new Set(), catalog, notes);
  } else if (wantBlender) {
    if (env.isCancelled?.()) throw new Error('cancelled');
    hook('blender', 'Blender 正在启动…', 0.45);
    const recipes = card.new_models.map((m, i) => ({ ...m, seed: (hashStr(`${payload.seed}|${payload.tile.x}|${payload.tile.z}|${m.id}`) % 100000) + 1 + i * 7 }));
    const inFile = path.join(env.jobDir, 'recipes.json');
    const modelDir = path.join(env.jobDir, 'models');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(inFile, JSON.stringify({ recipes }, null, 1));
    const r = await runBlenderScript(env.blender.path, env.blenderScript, ['--recipes', inFile, '--out', modelDir], {
      timeoutMs: 240000,
      onProgress: (k, text) => hook('blender', `Blender 正在建模：${text}`, 0.45 + k * 0.42),
      onSpawn: env.onBlenderSpawn,
    });
    let out = null;
    try {
      out = JSON.parse(fs.readFileSync(path.join(modelDir, 'models.json'), 'utf8'));
    } catch {
      out = null;
    }
    if (r.timedOut) notes.push('Blender 建模超时（240 秒），新模型改用模型库里最接近的');
    else if (!r.ok && !out) notes.push(`Blender 建模失败（退出码 ${r.code}），新模型改用模型库里最接近的`);
    for (const f of out?.failed ?? []) notes.push(`「${f.id}」没有建成：${f.error}`);
    const built = new Set((out?.models ?? []).map((m) => m.id));
    if (built.size) {
      models = out.models.map((m) => ({ ...m, jobId: env.jobId, url: `/generated/${env.jobId}/models/${m.id}.glb` }));
      blenderUsed = true;
      hook('blender', `Blender 建好了 ${models.length} 个新模型`, 0.9);
    }
    replaceMissing(card, built, catalog, notes);
  }

  // models built for earlier regions that this card uses again: the browser
  // fetches them like new ones (ones it already has are skipped there)
  const fresh = new Set(models.map((m) => m.id));
  const reused = [];
  for (const id of new Set(card.props.map((p) => p.model))) {
    if (fresh.has(id) || !known.has(id)) continue;
    reused.push(known.get(id));
  }
  models = [...models, ...reused];
  if (reused.length) notes.push(`复用了之前造的模型：${reused.map((m) => `「${m.label}」`).join('')}`);

  if (env.isCancelled?.()) throw new Error('cancelled');
  hook('export', '正在整理新区域的资源…', 0.94);
  const def = B.BIOMES[card.biome];
  // the natural biome needs no steering: leaving it out keeps the climate unbroken
  const follows = card.biome === natural;
  const spec = {
    x: payload.tile.x,
    z: payload.tile.z,
    biome: follows ? undefined : card.biome,
    name: card.name || undefined,
    peak: card.peak,
    rough: card.rough,
    land: card.land,
    // nothing asked for, nothing added: the feature a steered biome comes with anyway (a volcano)
    feature: card.feature ?? (follows ? undefined : def.feature),
    accent: card.accent,
    // additions on top of what the climate grows
    props: card.props,
    source: provider ? 'ai' : 'local',
    provider: provider ?? undefined,
    model: provider ? env.ai.providers.find((p) => p.label === provider)?.cfg.model : undefined,
    mood: card.mood,
    desc: card.desc,
    blender: blenderUsed,
    newModels: models.map((m) => m.id),
    // how many tiles this country needs, so the browser can open the rest of them
    extent: card.extent,
    extentWhy: card.extent_why,
  };
  return {
    spec,
    models,
    summary: {
      // the card's name, or the name of the climate that made the place
      name: spec.name || B.BIOMES[card.biome].label,
      extent: card.extent,
      sourceLabel: provider ? `AI · ${provider}${spec.model ? ' ' + spec.model : ''}` : '本地配方',
      biome: card.biome,
      blenderUsed,
      notes,
    },
  };
}
