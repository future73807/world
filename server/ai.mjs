/**
 * Talking to a language model through an OpenAI-compatible chat endpoint — the one
 * thing the player configures: address, model name, key.
 *
 * Services differ in how much they think before answering and in which parameters
 * they accept. The request path copes with all of it (measured against a real relay):
 *   - thinking models spend their output budget on reasoning: ask for the lowest
 *     reasoning effort, and if the answer is still nothing but reasoning, let the
 *     model finish thinking once with a much larger budget;
 *   - a service that does not know a parameter rejects the request with a 400: the
 *     parameter is dropped and the request sent again;
 *   - a relay sometimes has no upstream for a moment (429/502/503/504): one retry.
 * Keys never leave this process: they are read from runtime/secrets.json and sent
 * only to the endpoint the player configured.
 */

function baseUrl(cfg) {
  return String(cfg.base_url || '').replace(/\/+$/, '');
}

/** Error text in one readable sentence, whatever shape the service's error body has. */
function describeError(status, body) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.message || j?.error || j?.msg || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = String(body || '').slice(0, 200);
  }
  const hint =
    status === 401 || status === 403
      ? '鉴权失败：Key 不对'
      : status === 404
        ? '接口地址或模型名不对（404）'
        : status === 429
          ? '请求过多或额度不足（429）'
          : status >= 500
            ? '服务商暂时不可用'
            : '';
  return `${status || '无响应'}${hint ? ' · ' + hint : ''}${detail ? ' · ' + detail.slice(0, 160) : ''}`;
}

async function postJson(url, { headers = {}, body, timeoutMs = 60000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : `连不上接口：${e?.cause?.code || e?.message || e}`;
    return { status: 0, ok: false, text: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Extracts the first balanced JSON object from a model reply, tolerating code fences and prose. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const cand = s.slice(start, i + 1);
        try {
          return JSON.parse(cand);
        } catch {
          /* keep scanning for a later, well-formed object */
        }
      }
    }
  }
  return null;
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function chatOpenAI(cfg, system, user, opts) {
  const url = `${baseUrl(cfg)}/chat/completions`;
  const headers = { Authorization: `Bearer ${cfg.key}` };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const bodyFor = (maxTokens) => ({
    model: cfg.model,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature,
    // a plain connectivity check asks for nothing special
    ...(opts.thinking === false ? {} : { reasoning_effort: 'low' }),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  const send = async (body, timeoutMs) => {
    let r = await postJson(url, { headers, body, timeoutMs });
    // a service that does not know a parameter rejects the whole request: drop it, once each
    if (!r.ok && r.status === 400 && body.reasoning_effort) {
      delete body.reasoning_effort;
      r = await postJson(url, { headers, body, timeoutMs });
    }
    if (!r.ok && r.status === 400 && body.response_format) {
      delete body.response_format;
      r = await postJson(url, { headers, body, timeoutMs });
    }
    if (!r.ok && (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504)) {
      await wait(1500);
      r = await postJson(url, { headers, body, timeoutMs });
    }
    if (!r.ok) return { error: describeError(r.status, r.text) };
    let j;
    try {
      j = JSON.parse(r.text);
    } catch {
      return { error: '服务商返回的不是 JSON' };
    }
    const message = j?.choices?.[0]?.message ?? {};
    const content = message.content ?? j?.choices?.[0]?.text ?? j?.output?.text;
    const text = Array.isArray(content) ? content.map((c) => c?.text || c?.content || '').join('') : String(content ?? '');
    const reasoning = message.reasoning_content || message.reasoning || message.thinking || '';
    return { text, reasoning: typeof reasoning === 'string' ? reasoning : '', finish: j?.choices?.[0]?.finish_reason, usage: j?.usage, modelEcho: j?.model };
  };

  const answer = (a) => ({ ok: true, text: a.text, truncated: a.finish === 'length', usage: a.usage, model: a.modelEcho });
  const first = await send(bodyFor(opts.maxTokens), opts.timeoutMs);
  if (first.error) return { ok: false, error: first.error };
  if (first.text.trim()) return answer(first);
  if (first.reasoning) {
    // the budget ran out before the answer: let the model finish thinking once
    const second = await send(bodyFor(Math.max(opts.maxTokens * 6, 12000)), Math.max(opts.timeoutMs, 150000));
    if (second.error) return { ok: false, error: second.error };
    if (second.text.trim()) return answer(second);
    return { ok: false, error: '模型只输出了思考过程，没有给出答案', usage: second.usage };
  }
  if (opts.allowEmpty) return answer(first);
  return { ok: false, error: '模型返回了空内容' };
}

/**
 * One call to the configured model.
 * @param {object} cfg  { base_url, model, key }
 * @returns {Promise<{ok:boolean, text?:string, error?:string, latency_ms:number, usage?:object, model?:string, truncated?:boolean}>}
 */
export async function chat(cfg, system, user, opts = {}) {
  const o = {
    maxTokens: opts.maxTokens ?? 1800,
    temperature: opts.temperature ?? 0.7,
    timeoutMs: opts.timeoutMs ?? 60000,
    jsonMode: opts.jsonMode ?? true,
    allowEmpty: opts.allowEmpty ?? false,
    thinking: opts.thinking ?? true,
  };
  if (!String(cfg?.base_url || '').trim()) return { ok: false, error: '未填写接口地址', latency_ms: 0 };
  if (!String(cfg?.model || '').trim()) return { ok: false, error: '未填写模型名称', latency_ms: 0 };
  if (!String(cfg?.key || '').trim()) return { ok: false, error: '未填写 API Key', latency_ms: 0 };
  const t0 = Date.now();
  let r;
  try {
    r = await chatOpenAI(cfg, system, user, o);
  } catch (e) {
    r = { ok: false, error: `调用出错：${e?.message || e}` };
  }
  return { ...r, latency_ms: Date.now() - t0 };
}
