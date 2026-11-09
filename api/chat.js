// Vercel Serverless Function -> /api/chat
// Переменные окружения: GROQ_API_KEY (бесплатный Groq) ИЛИ ANTHROPIC_API_KEY. Необязательно: MODEL, SITE_ORIGIN.
const hits = {};

// ---- общая часть: принимает запрос в формате Anthropic и умеет работать с Groq или Anthropic ----
function toOpenAI(b) {
  const out = [];
  if (b.system) out.push({ role: 'system', content: String(b.system).slice(0, 4000) });
  for (const m of b.messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const parts = [], calls = [], results = [];
    for (const c of m.content || []) {
      if (c.type === 'text') parts.push({ type: 'text', text: c.text });
      else if (c.type === 'image' && c.source) parts.push({ type: 'image_url', image_url: { url: 'data:' + c.source.media_type + ';base64,' + c.source.data } });
      else if (c.type === 'tool_use') calls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } });
      else if (c.type === 'tool_result') results.push({ role: 'tool', tool_call_id: c.tool_use_id, content: String(c.content) });
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: parts.map((p) => p.text).join('') || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      results.forEach((r) => out.push(r));
      if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }
  return out;
}

function fromOpenAI(d) {
  const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
  const content = [];
  const text = typeof m.content === 'string' ? m.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
  if (text) content.push({ type: 'text', text });
  const calls = m.tool_calls || [];
  for (const c of calls) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch (e) {}
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  return { content, stop_reason: calls.length ? 'tool_use' : 'end_turn' };
}

// Подбирает модель, которая реально доступна на вашем аккаунте Groq (список меняется).
let modelCache = null, modelAt = 0;
async function pickModels(env) {
  if (env.MODEL) return { text: env.MODEL, vision: env.VISION_MODEL || null, ids: [] };
  if (modelCache && Date.now() - modelAt < 3600000) return modelCache;
  let ids = [];
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY } });
    const j = await r.json();
    ids = (j.data || []).map((m) => m.id);
  } catch (e) {}
  const has = (a) => a.find((x) => ids.includes(x));
  const text = has(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'llama-3.1-8b-instant'])
    || ids.find((x) => !/whisper|tts|guard|orpheus|compound|safeguard/i.test(x));
  const vision = has(['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct']) || null;
  modelCache = { text: text || 'llama-3.3-70b-versatile', vision, ids };
  modelAt = Date.now();
  return modelCache;
}

async function askAI(env, b) {
  const tools = Array.isArray(b.tools) ? b.tools.slice(0, 16) : [];
  if (env.GROQ_API_KEY) {
    const picked = await pickModels(env);
    let msgs = toOpenAI(b);
    const hasImg = msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    let model = picked.text;
    if (hasImg) {
      if (picked.vision) model = picked.vision;
      else msgs = msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => p.type !== 'image_url') } : m));
    }
    const body = { model, max_completion_tokens: 4096, messages: msgs };
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 429) return { status: 429, json: { error: { type: 'rate_limit_error' } } };
    if (!r.ok) return { status: 502, json: { error: 'upstream' } };
    return { status: 200, json: fromOpenAI(await r.json()) };
  }
  if (env.ANTHROPIC_API_KEY) {
    const body = { model: env.MODEL || 'claude-haiku-5-5', max_tokens: 1024, system: String(b.system || '').slice(0, 4000), messages: b.messages };
    if (tools.length) body.tools = tools;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    return { status: r.status, json: j };
  }
  return { status: 500, json: { error: 'no_key' } };
}

// ---- диагностика: открыть /api/chat в браузере (GET). Ключ не показывается. ----
async function diag(env) {
  if (!env.GROQ_API_KEY) return { provider: env.ANTHROPIC_API_KEY ? 'anthropic' : 'none', note: 'GROQ_API_KEY не найден' };
  const picked = await pickModels(env);
  const model = picked.text;
  const call = async (extra) => {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ model, max_completion_tokens: 20, messages: [{ role: 'user', content: 'ping' }] }, extra)),
      });
      let t = '';
      try { t = await r.text(); } catch (e) {}
      let m = t.slice(0, 300);
      try { const j = JSON.parse(t); m = (j.error && j.error.message) || 'ok'; } catch (e) {}
      return { status: r.status, message: String(m).slice(0, 300) };
    } catch (e) { return { status: 0, message: String((e && e.message) || e).slice(0, 200) }; }
  };
  const tool = [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {}, required: [] } } }];
  const k = String(env.GROQ_API_KEY);
  return { provider: 'groq', model, vision_model: picked.vision, available_models: picked.ids, key_starts_gsk: k.startsWith('gsk_'), key_length: k.length, plain: await call({}), with_tools: await call({ tools: tool }) };
}

module.exports = async (req, res) => {
  const env = process.env;
  if (req.method === 'GET') return res.status(200).json(await diag(env));
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!env.GROQ_API_KEY && !env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'no_key' });
  const origin = req.headers.origin;
  if (env.SITE_ORIGIN && origin && origin !== env.SITE_ORIGIN) return res.status(403).json({ error: 'forbidden' });

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0];
  const now = Date.now();
  const list = (hits[ip] || []).filter((t) => now - t < 60000);
  if (list.length >= 20) return res.status(429).json({ error: { type: 'rate_limit_error' } });
  list.push(now); hits[ip] = list;

  const b = req.body || {};
  if (!Array.isArray(b.messages) || b.messages.length > 80) return res.status(400).json({ error: 'bad_request' });
  const out = await askAI(env, b);
  res.status(out.status).json(out.json);
};
