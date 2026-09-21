// ============================================================================
//  Offline mock of the two upstream APIs, for dry runs without keys/network.
//
//    node server.mjs --mock        (starts this in-process and points both
//                                   providers at it)
//    node dev/mock-upstream.mjs    (standalone on port 8790)
//
//  It imitates the wire formats only:
//    POST /v1/systemone            TypeSafe System One (Jev)
//    POST /api/alpha/decisions     OpenRouter Decisions API (same body/answers)
//    POST /api/v1/chat/completions OpenRouter / OpenAI-style chat completions
//    GET  /v1/models, /api/v1/models
//
//  Decisions come from a tiny rule-of-thumb on the state the game sends, with
//  artificial latency (MOCK_JEV_LATENCY_MS, default 140; MOCK_LLM_LATENCY_MS,
//  default 1800). It is NOT a model — it exists to exercise the plumbing.
// ============================================================================

import http from 'node:http';

const JEV_LATENCY_MS = Number(process.env.MOCK_JEV_LATENCY_MS || 140);
const LLM_LATENCY_MS = Number(process.env.MOCK_LLM_LATENCY_MS || 1800);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => Math.max(20, Math.round(base * (0.75 + Math.random() * 0.5)));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, extraHeaders = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders });
  res.end(data);
}

/** Pull the facts the rule needs out of a JSON state, a prose state, or a chat transcript. */
function extractFacts(anything, which = 'nearest') {
  let obj = anything && typeof anything === 'object' ? anything : null;
  if (!obj) {
    const text = String(anything == null ? '' : anything);
    const m = text.match(/\{[\s\S]*\}/); // a chat transcript embeds the JSON state
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
    if (!obj || !('nearest_obstacle' in obj)) return factsFromProse(text, which);
  }
  return factsFromObject(obj, which);
}

function factsFromObject(state, which = 'nearest') {
  const o = which === 'next' ? state.next_obstacle : state.nearest_obstacle;
  const t = state.timing || {};
  if (!o) return { hasObstacle: false };
  return {
    hasObstacle: true,
    airborne: state.dino && state.dino.state === 'jumping',
    flying: o.flying_height ? o.flying_height.split(' ')[0] : null,
    timing: o.jump_timing ? o.jump_timing.split(' ')[0] : null,
    arrivesMs: o.arrives_in_ms_when_answer_lands != null ? o.arrives_in_ms_when_answer_lands : o.arrives_in_ms,
    window: t.jump_window_ms ? { start: t.jump_window_ms.start_ms, end: t.jump_window_ms.end_ms } : null,
  };
}

function factsFromProse(text, which = 'nearest') {
  if (which === 'next') {
    const i = text.indexOf('Behind it');
    if (i < 0) return { hasObstacle: false };
    const seg = text.slice(i, text.indexOf('Your recent latency') > i ? text.indexOf('Your recent latency') : undefined);
    const flying = seg.match(/flying (low|mid|high)/i);
    return { hasObstacle: true, airborne: false, flying: flying ? flying[1].toLowerCase() : null, timing: null, arrivesMs: null, window: null };
  }
  if (/no obstacle (in sight|to decide about)/i.test(text) || !/Nearest obstacle/i.test(text)) return { hasObstacle: false };
  const nearest = text.slice(text.indexOf('Nearest obstacle'), text.search(/Behind it|Your recent latency/) > 0 ? text.search(/Behind it|Your recent latency/) : undefined);
  const flying = nearest.match(/flying (low|mid|high)/i);
  const timing = nearest.match(/Jump timing: ([a-z_]+)/i);
  const arrives = nearest.match(/about (-?\d+) ms after your answer lands/i);
  const win = text.match(/between (-?\d+) and (-?\d+) ms away/i);
  return {
    hasObstacle: true,
    airborne: /The dino is jumping/i.test(text),
    flying: flying ? flying[1].toLowerCase() : null,
    timing: timing ? timing[1].toLowerCase() : null,
    arrivesMs: arrives ? Number(arrives[1]) : null,
    window: win ? { start: Number(win[1]), end: Number(win[2]) } : null,
  };
}

/** The rule of thumb. Returns {action, danger}. */
function decide(facts) {
  if (!facts.hasObstacle) return { action: 'run', danger: 0 };
  if (facts.flying === 'mid') {
    const soon = facts.arrivesMs == null || facts.arrivesMs < 700;
    return { action: soon ? 'duck' : 'run', danger: soon ? 2 : 1 };
  }
  if (facts.flying === 'high') return { action: 'run', danger: 1 };
  // Harness-timed contract: no timing facts in the state → just say what to do about it.
  if (!facts.timing && !facts.window) return { action: 'jump', danger: facts.arrivesMs != null && facts.arrivesMs < 600 ? 2 : 1 };
  if (facts.airborne) return { action: 'run', danger: 1 };
  let timing = facts.timing;
  if (!timing && facts.window && facts.arrivesMs != null) {
    const hi = Math.max(facts.window.start, facts.window.end);
    const lo = Math.min(facts.window.start, facts.window.end);
    timing = facts.arrivesMs > hi ? 'too_early' : facts.arrivesMs < lo ? 'too_late' : 'now';
  }
  if (timing === 'now') return { action: 'jump', danger: 2 };
  if (timing === 'too_late') return { action: 'jump', danger: 3 };
  if (timing === 'not_needed') return { action: 'run', danger: 1 };
  return { action: 'run', danger: facts.arrivesMs != null && facts.arrivesMs < 1200 ? 1 : 0 };
}

function distribution(keys, winner, confidence) {
  const rest = keys.filter((k) => k !== winner);
  const leftover = 1 - confidence;
  const weights = rest.map(() => Math.random());
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = {};
  rest.forEach((k, i) => { out[k] = Number(((weights[i] / sum) * leftover).toFixed(4)); });
  out[winner] = Number((1 - rest.reduce((a, k) => a + out[k], 0)).toFixed(4));
  return out;
}

function answerQuestions(state, questions) {
  const facts = extractFacts(state);
  const verdict = decide(facts);
  const nextVerdict = decide(extractFacts(state, 'next'));
  const answers = {};
  for (const [name, q] of Object.entries(questions || {})) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria || {});
      const wanted = /next/i.test(name) ? nextVerdict.action : verdict.action;
      let pick = keys.includes(wanted) ? wanted : keys[0];
      const conf = Number((0.72 + Math.random() * 0.26).toFixed(4));
      const probabilities = distribution(keys, pick, conf);
      answers[name] = { type: 'choice', choice: pick, confidence: probabilities[pick], probabilities };
    } else if (q.type === 'score') {
      const levels = (q.criteria || []).length || 2;
      const target = Math.min(levels - 1, verdict.danger);
      const keys = Array.from({ length: levels }, (_, i) => String(i));
      const probabilities = distribution(keys, String(target), 0.7 + Math.random() * 0.25);
      const score = keys.reduce((acc, k) => acc + Number(k) * probabilities[k], 0);
      const legend = {};
      keys.forEach((k) => { legend[k] = q.criteria[Number(k)]; });
      answers[name] = { type: 'score', score: Number(score.toFixed(3)), confidence: probabilities[String(target)], legend, probabilities };
    } else if (q.type === 'noul') {
      answers[name] = { type: 'noul', noul: Number((0.55 + Math.random() * 0.4).toFixed(4)) };
    }
  }
  return { answers, verdict };
}

function approxTokens(obj) {
  return Math.round(JSON.stringify(obj).length / 3.6);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/v1/models') {
      return send(res, 200, { models: [{ name: 'jev-latest', description: 'MOCK — not a real model', release_date: '2026-09-15' }, { name: 'jev-1.13.0', description: 'MOCK', release_date: '2026-09-15' }] });
    }
    if (req.method === 'GET' && p === '/api/v1/models') {
      return send(res, 200, { data: [
        { id: 'mock/fast-llm', name: 'Mock fast LLM', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
        { id: 'mock/slow-llm', name: 'Mock slow LLM', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'typesafe/jev-1.13', name: 'TypeSafe: Jev 1.13 (mock)', context_length: 32000, pricing: { prompt: '0.000000042', completion: '0' } },
      ] });
    }
    if (req.method === 'POST' && (p === '/v1/systemone' || p === '/api/alpha/decisions')) {
      const body = await readBody(req);
      if (!body.questions || typeof body.questions !== 'object') return send(res, 422, { error: { message: 'questions is required' } });
      await sleep(jitter(JEV_LATENCY_MS));
      const { answers } = answerQuestions(body.state, body.questions);
      return send(res, 200, { model: `${body.model || 'jev-latest'} (MOCK)`, answers, usage: { input_tokens: approxTokens(body), output_tokens: 0 } }, { 'x-typesafe-request-id': `mock_${Date.now().toString(36)}` });
    }
    if (req.method === 'POST' && p === '/api/v1/chat/completions') {
      const body = await readBody(req);
      const model = body.model || 'mock/fast-llm';
      if (model.startsWith('typesafe/')) {
        return send(res, 400, { error: { message: `${model} is a decisions model and cannot be used with the chat/completions endpoint.`, code: 400 } });
      }
      await sleep(jitter(model.includes('slow') ? LLM_LATENCY_MS * 2 : LLM_LATENCY_MS));
      const userMsg = (body.messages || []).filter((m) => m.role === 'user').pop();
      const { verdict } = answerQuestions(userMsg ? userMsg.content : '', { action: { type: 'choice', criteria: { jump: null, duck: null, run: null } } });
      const nextVerdict = decide(extractFacts(userMsg ? userMsg.content : '', 'next'));
      const content = JSON.stringify({ action: verdict.action, next_action: nextVerdict.action, danger: verdict.danger, reason: 'mock rule of thumb' });
      const promptTokens = approxTokens(body.messages);
      return send(res, 200, {
        id: `gen-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 18, total_tokens: promptTokens + 18 },
      });
    }
    return send(res, 404, { error: { message: `mock: no route ${req.method} ${p}` } });
  } catch (err) {
    return send(res, 400, { error: { message: err.message } });
  }
}

export function startMockUpstream({ port = Number(process.env.MOCK_PORT || 8790) } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      console.log(`  [mock upstream] ${base}  (Jev ~${JEV_LATENCY_MS} ms, LLM ~${LLM_LATENCY_MS} ms)`);
      resolve(base);
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startMockUpstream().catch((err) => { console.error(err); process.exit(1); });
}
