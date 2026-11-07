// api/chat.js — серверная часть BaltabekovAI (Vercel).
// Сайт шлёт сюда запрос, а этот файл отправляет его в ИИ-сервис с твоим ключом.
// Ключ берётся из переменных Vercel и в сайт не попадает.
//
// Переменные в Vercel (Settings → Environment Variables):
//   AI_API_KEY   — твой ключ
//   AI_BASE_URL  — адрес API, например https://api.example.com/v1 (до /chat/completions)
//   AI_MODEL     — название модели из списка сервиса

function toOAI(msgs) {
  const out = [];
  for (const m of msgs || []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const parts = [], tools = [], calls = [];
    let txt = '';
    for (const b of m.content || []) {
      if (b.type === 'text') { parts.push({ type: 'text', text: b.text }); txt += b.text; }
      else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: 'data:' + b.source.media_type + ';base64,' + b.source.data } });
      else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      else if (b.type === 'tool_result') tools.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
    }
    if (m.role === 'assistant') {
      const a = { role: 'assistant', content: txt || null };
      if (calls.length) a.tool_calls = calls;
      out.push(a);
      continue;
    }
    out.push(...tools);
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const key = process.env.AI_API_KEY;
  const base = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
  const model = process.env.AI_MODEL;
  if (!key || !base || !model) return res.status(200).json({ error: 'no_key' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }

  const body = {
    model,
    max_tokens: Math.min(Number(b.max_tokens) || 2000, 8000),
    messages: [{ role: 'system', content: b.system || '' }, ...toOAI(b.messages)],
  };
  if (Array.isArray(b.tools) && b.tools.length) {
    body.tools = b.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  let r, d = {};
  try {
    r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    return res.status(502).json({ error: 'upstream_unreachable' });
  }

  if (!r.ok) {
    console.error('AI error', r.status, JSON.stringify(d).slice(0, 500));
    return res.status(r.status === 429 ? 429 : 502).json({
      error: { type: r.status === 429 ? 'rate_limit_error' : 'api_error', message: (d.error && d.error.message) || '' },
    });
  }

  const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  return res.status(200).json({
    content,
    stop_reason: m.tool_calls && m.tool_calls.length ? 'tool_use' : 'end_turn',
  });
};
