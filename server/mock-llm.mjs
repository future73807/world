/**
 * A local stand-in for an OpenAI-compatible chat endpoint, used to exercise the
 * region pipeline (AI call -> validation -> Blender) without a real key.
 * It always answers with the same deliberately messy card.
 *   node mock-llm.mjs [port]
 *
 * The wish picks a scripted answer:
 *   (anything else)  the messy card: unknown models, too many landmarks and new models,
 *                    asking for a country two tiles wide
 *   复用              a card that only reuses a model Blender built earlier
 *   慢                think for 6 s first (to watch the generating state, to cancel)
 *   拒绝参数          reject a request that carries `thinking` with a 400
 *   空回答            reasoning only, no content (a thinking model out of tokens)
 */
import http from 'node:http';

const CARD = {
  name: '「灯笼林」',
  biome: 'forest',
  mood: '暖黄的灯笼在雾里一盏一盏亮起来',
  desc: '一片挂着发光灯笼的阔叶林，林间有石拱。',
  peak: 12,
  rough: 0.4,
  land: 0.7,
  feature: 'none',
  accent: '#cfe6a8',
  // this country asks for two tiles: the pipeline opens one more with the same card
  extent: 2,
  extent_why: '灯笼林要连着走两格才成林',
  props: [
    { model: 'Lantern Tree!', n: 12 },
    { model: 'forest_tree_a', n: 20 },
    { model: 'shrub_a', n: 8 },
    { model: 'grass_a', n: 200 },
    { model: 'made_up_model', n: 5 },
    { model: 'landmark_arch', n: 1, landmark: true },
    { model: 'forest_tree_b', n: 3, landmark: true },
  ],
  needs_blender: true,
  new_models: [
    {
      id: 'Lantern Tree!',
      label: '灯笼树',
      kind: 'tree',
      desc: '枝头挂着暖黄灯笼的阔叶树',
      fallback: 'forest_tree_a',
      parts: [
        { type: 'tree', h: 4.2, r0: 0.3, bend: [0.2, 0.1], roots: { n: 3 }, branches: { n: 4, len: [1.2, 1.8], rise: [0.3, 0.6] },
          canopy: { size: [3.6, 1.6, 3.6], lobes: 5, tris: 500, paint: { color: '#5b8f5a', color2: '#a7d98a', under: '#2f5f45', mode: 'normal' } } },
        { type: 'loft', glow: true, sides: 6, at: [1.2, 3.4, 0.4], rings: [{ y: -0.25, r: 0.02 }, { y: -0.12, r: 0.16 }, { y: 0.12, r: 0.16 }, { y: 0.25, r: 0.02 }], paint: { color: '#ffb347', color2: '#fff1c2', mode: 'normal' } },
        { type: 'loft', glow: true, sides: 6, at: [-1.1, 3.0, -0.6], rings: [{ y: -0.25, r: 0.02 }, { y: -0.12, r: 0.16 }, { y: 0.12, r: 0.16 }, { y: 0.25, r: 0.02 }], paint: { color: '#ffb347', color2: '#fff1c2', mode: 'normal' } },
      ],
    },
    { id: 'broken_thing', label: '坏模型', kind: 'rock', fallback: 'rock_b', parts: [{ type: 'ufo' }] },
    { id: 'third_model', label: '第三个', kind: 'plant', parts: [{ type: 'tuft', n: 6 }] },
  ],
};

// a wish containing 复用 answers with a card that only uses a model Blender built earlier
const REUSE_CARD = {
  name: '灯笼小径',
  biome: 'forest',
  mood: '上次亮起来的灯笼，这次一直亮到路口',
  desc: '沿着灯笼树走的小径，没有新东西。',
  peak: 12,
  rough: 0.4,
  land: 0.7,
  feature: 'none',
  accent: '#cfe6a8',
  props: [
    { model: 'lanterntree', n: 9 },
    { model: 'grass_a', n: 40 },
  ],
  needs_blender: false,
  new_models: [],
};

const port = Number(process.argv[2] || 18080);
let calls = 0;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      let info = {};
      let j = null;
      try {
        j = JSON.parse(body);
        info = { model: j.model, messages: j.messages?.length, systemChars: j.messages?.[0]?.content?.length, userChars: j.messages?.[1]?.content?.length, auth: req.headers.authorization ? 'bearer-present' : 'none', max_tokens: j.max_tokens, thinking: j.thinking ?? null, response_format: j.response_format?.type ?? null };
      } catch {
        info = { parse: 'failed' };
        j = null;
      }
      const said = String(j?.messages?.[1]?.content ?? j?.contents?.[0]?.parts?.[0]?.text ?? '');
      console.log(`[mock] call #${calls} ${JSON.stringify(info)}`);
      // a wish containing 拒绝参数 is answered like a service that does not know `thinking`
      if (said.includes('拒绝参数') && j?.thinking) {
        console.log('[mock] rejecting the unknown parameter "thinking" with 400');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown parameter: thinking', type: 'invalid_request_error' } }));
        return;
      }
      // a wish containing 空回答 is answered the way a thinking model answers when its
      // output budget ran out: reasoning only, no content
      if (said.includes('空回答')) {
        console.log('[mock] answering with reasoning only');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock', model: 'mock-1', choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '让我想想这块格子该放什么……' }, finish_reason: 'length' }], usage: { prompt_tokens: 3000, completion_tokens: 3000 } }));
        return;
      }
      // a connectivity check gets a plain OK
      if (said.trim() === 'OK') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
        return;
      }
      // a wish containing 慢 makes it think for 6 s, to look at the generating state
      const slow = said.includes('慢');
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // anything that is not a chat request (health probes) gets the messy card
        const card = said.includes('复用') ? REUSE_CARD : CARD;
        console.log(`[mock] answering with ${card === REUSE_CARD ? 'REUSE' : 'MESSY'} card`);
        res.end(JSON.stringify({ id: 'mock', model: 'mock-1', choices: [{ index: 0, message: { role: 'assistant', content: '好的，这是区域卡：\n```json\n' + JSON.stringify(card) + '\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 500 } }));
      }, slow ? 6000 : 400);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock llm on http://127.0.0.1:${port}/v1`));
