#!/usr/bin/env node
// ============================================================================
//  Jev plays Dino — local server
//
//  * Serves the game (./public) at http://localhost:8787
//  * Proxies model calls so the API keys in config.mjs never reach the browser:
//      POST /api/decide   -> TypeSafe  POST /v1/systemone            (Jev direct)
//                         -> OpenRouter POST /api/alpha/decisions     (Jev via OpenRouter)
//                         -> OpenRouter POST /api/v1/chat/completions (any LLM)
//      GET  /api/models   -> model lists (for the pickers on the start screen)
//      POST /api/ping     -> one tiny real call, to check a key + latency before a demo
//      GET  /api/config   -> which providers have keys, default model names
//
//  Zero dependencies. Node.js 20+ (built-in fetch).
//  Run `node server.mjs --mock` to start an offline mock of both APIs in-process.
// ============================================================================

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, SETTINGS } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || SETTINGS.port || 8787);
const UPSTREAM_TIMEOUT_MS = 20_000;
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const USE_MOCK = process.argv.includes('--mock');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- keys -----

function isPlaceholder(value) {
  return !value || /^\s*$/.test(value) || /^PASTE[_-]/i.test(value) || /YOUR[_-].*KEY/i.test(value);
}

/** Hardcoded value from config.mjs first, then the environment variable of the same name. */
function resolveKey(name) {
  if (!isPlaceholder(KEYS[name])) return KEYS[name].trim();
  if (!isPlaceholder(process.env[name])) return process.env[name].trim();
  return null;
}

function maskKey(key) {
  return key.length <= 10 ? '****' : `${key.slice(0, 5)}…${key.slice(-4)}`;
}

// ----------------------------------------------------------- providers -----

let typesafeBase = (process.env.TYPESAFE_BASE_URL || SETTINGS.typesafeBaseUrl).replace(/\/+$/, '');
let openrouterBase = (process.env.OPENROUTER_BASE_URL || SETTINGS.openrouterBaseUrl).replace(/\/+$/, '');
const LAYA = { inProcess: true, autoload: false, onnxSubfolder: null, threads: null, baseUrl: 'http://127.0.0.1:8000', model: 'laya', ...(SETTINGS.laya || {}) };
let layaBase = (process.env.LAYA_BASE_URL || LAYA.baseUrl).replace(/\/+$/, '');

if (USE_MOCK) {
  const { startMockUpstream } = await import('./dev/mock-upstream.mjs');
  const mockUrl = await startMockUpstream();
  typesafeBase = mockUrl;
  openrouterBase = mockUrl;
  if (!process.env.LAYA_BASE_URL) layaBase = mockUrl;
}

// ------------------------------------------------- Laya, in-process runtime --
// Optional: `npm install @receptron/laya` in this folder makes Laya run inside this server
// (ONNX Runtime, no Python). Without it, Laya calls go to the local HTTP server at layaBase.

const layaRuntime = { status: 'not-installed', error: null, model: null, progress: null, loadedAt: null, instance: null, module: null, loading: null };

if (LAYA.inProcess) {
  try {
    layaRuntime.module = await import('@receptron/laya');
    layaRuntime.status = 'idle';
  } catch (err) {
    layaRuntime.status = 'not-installed';
    layaRuntime.error = /Cannot find (package|module)/i.test(String(err && err.message)) ? null : String(err && err.message || err);
  }
}

function loadLayaInProcess() {
  if (layaRuntime.instance) return Promise.resolve(layaRuntime.instance);
  if (layaRuntime.loading) return layaRuntime.loading;
  if (!layaRuntime.module) return Promise.reject(new Error('@receptron/laya is not installed'));
  layaRuntime.status = 'loading';
  layaRuntime.error = null;
  layaRuntime.progress = { file: null, received: 0, total: 0 };
  const options = {
    onProgress: ({ file, received, total }) => { layaRuntime.progress = { file, received, total }; },
  };
  if (LAYA.onnxSubfolder) options.subfolder = LAYA.onnxSubfolder;
  if (process.env.LAYA_CACHE) options.cacheDir = process.env.LAYA_CACHE;
  if (LAYA.threads) options.sessionOptions = { intraOpNumThreads: Number(LAYA.threads) };
  const started = performance.now();
  layaRuntime.loading = layaRuntime.module.Laya.load(options)
    .then(async (instance) => {
      // warm-up so the first game call is not the slow one
      try { await instance.systemOne('warm-up', { ok: { type: 'noul', instructions: 'Is this a warm-up?' } }); } catch { /* ignore */ }
      layaRuntime.instance = instance;
      layaRuntime.status = 'ready';
      layaRuntime.model = `laya${LAYA.onnxSubfolder ? '/' + LAYA.onnxSubfolder : ''} (ONNX, in-process)`;
      layaRuntime.loadedAt = Date.now();
      layaRuntime.progress = null;
      console.log(`  Laya loaded in-process in ${Math.round((performance.now() - started) / 100) / 10} s`);
      return instance;
    })
    .catch((err) => {
      layaRuntime.status = 'error';
      layaRuntime.error = String(err && err.message || err);
      layaRuntime.loading = null;
      console.error('  Laya failed to load:', layaRuntime.error);
      throw err;
    });
  return layaRuntime.loading;
}

async function layaInProcessDecide(payload) {
  const instance = await loadLayaInProcess();
  const started = performance.now();
  try {
    const result = await instance.systemOne(payload.state, payload.questions);
    const latency_ms = Math.round(performance.now() - started);
    return { ok: true, status: 200, latency_ms, url: 'in-process (@receptron/laya, ONNX Runtime)', method: 'call', request_id: null, sent_headers: {}, response: { model: layaRuntime.model, ...result } };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - started);
    return { ok: false, status: 422, latency_ms, url: 'in-process (@receptron/laya)', method: 'call', error: `Laya rejected the request: ${err && err.message || err}`, response: { error: { message: String(err && err.message || err) } } };
  }
}

const layaHttpProbe = { at: 0, reachable: false, detail: null };
async function probeLayaHttp() {
  if (Date.now() - layaHttpProbe.at < 5000) return layaHttpProbe;
  layaHttpProbe.at = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(layaBase + '/v1/models', { signal: controller.signal });
    layaHttpProbe.reachable = r.ok;
    let detail = null;
    try { const j = await r.json(); detail = j && j.models && j.models[0] ? `${j.models[0].name}: ${j.models[0].description || ''}`.trim() : null; } catch { /* ignore */ }
    layaHttpProbe.detail = detail || (r.ok ? 'reachable' : `HTTP ${r.status}`);
  } catch (err) {
    layaHttpProbe.reachable = false;
    layaHttpProbe.detail = `not reachable (${err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || err})`;
  } finally {
    clearTimeout(timer);
  }
  return layaHttpProbe;
}

/** Serve one Laya request: in-process when the runtime is ready (or installed and idle), else the local HTTP server. */
async function layaDecide(payload) {
  const mode = await layaMode();
  if (mode === 'in-process') return layaInProcessDecide(payload);
  if (mode === 'http') return forward(PROVIDERS.laya, PROVIDERS.laya.decidePath, 'POST', payload);
  const hint = layaRuntime.status === 'loading'
    ? `Laya is still loading in-process (${layaRuntime.progress && layaRuntime.progress.total ? Math.round((layaRuntime.progress.received / layaRuntime.progress.total) * 100) + '% of ' + layaRuntime.progress.file : 'starting'}). Try again in a moment.`
    : layaRuntime.status === 'error'
      ? `Laya failed to load in-process: ${layaRuntime.error}`
      : `Laya is not available: install the in-process runtime (npm install @receptron/laya, then restart) or start a local server (pip install laya && python dev/laya_server.py) — expected at ${layaBase}.`;
  return { ok: false, status: 503, latency_ms: 0, url: layaBase, error: hint };
}

/** How Laya calls are served right now: 'in-process' | 'http' | 'none'. */
async function layaMode() {
  if (layaRuntime.status === 'ready') return 'in-process';
  if (layaRuntime.status === 'loading' || layaRuntime.status === 'idle') {
    const probe = await probeLayaHttp();
    if (probe.reachable) return 'http';
    return layaRuntime.status === 'idle' ? 'in-process' : 'none';
  }
  const probe = await probeLayaHttp();
  return probe.reachable ? 'http' : 'none';
}

const PROVIDERS = {
  typesafe: {
    label: 'Jev — TypeSafe API (direct)',
    base: () => typesafeBase,
    keyName: 'TYPESAFE_API_KEY',
    decidePath: '/v1/systemone',
    modelsPath: '/v1/models',
    defaultModel: SETTINGS.jevModel,
    kind: 'decisions',
  },
  openrouter_decisions: {
    label: 'Jev — via OpenRouter Decisions API',
    base: () => openrouterBase,
    keyName: 'OPENROUTER_API_KEY',
    decidePath: '/api/alpha/decisions',
    modelsPath: '/api/v1/models',
    defaultModel: SETTINGS.openrouterJevModel,
    kind: 'decisions',
  },
  openrouter_chat: {
    label: 'Any LLM — via OpenRouter chat completions',
    base: () => openrouterBase,
    keyName: 'OPENROUTER_API_KEY',
    decidePath: '/api/v1/chat/completions',
    modelsPath: '/api/v1/models',
    defaultModel: SETTINGS.openrouterChatModel,
    kind: 'chat',
  },
  laya: {
    label: 'Laya — open-weights System One model, local',
    base: () => layaBase,
    keyName: null,                       // no key: runs on this machine
    decidePath: '/v1/systemone',
    modelsPath: '/v1/models',
    defaultModel: LAYA.model,
    kind: 'decisions',
  },
};

/**
 * Forward one request upstream, adding the Authorization header.
 * Returns a plain object the browser can render in the live panel; the key is masked.
 */
async function forward(provider, pathname, method, body, { optionalKey = false } = {}) {
  const key = provider.keyName ? resolveKey(provider.keyName) : null;
  if (!key && !optionalKey && provider.keyName) {
    return {
      ok: false,
      status: 401,
      latency_ms: 0,
      error: `${provider.keyName} is not set. Paste it into config.mjs (next to server.mjs) or export it as an environment variable, then restart the server.`,
    };
  }
  const url = provider.base() + pathname;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Title': 'Jev plays Dino',
    'HTTP-Referer': `http://localhost:${PORT}`,
  };
  if (key) headers.Authorization = `Bearer ${key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const started = performance.now();
  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const latency_ms = Math.round(performance.now() - started);
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return {
      ok: upstream.ok,
      status: upstream.status,
      latency_ms,
      url,
      method,
      request_id: upstream.headers.get('x-typesafe-request-id') || upstream.headers.get('x-request-id') || null,
      sent_headers: { ...headers, ...(key ? { Authorization: `Bearer ${maskKey(key)}` } : {}) },
      response: json !== undefined ? json : { raw_text: text.slice(0, 4000) },
      error: upstream.ok ? undefined : `Upstream returned HTTP ${upstream.status}`,
    };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - started);
    const timedOut = err && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      latency_ms,
      url,
      method,
      error: timedOut
        ? `Upstream did not answer within ${UPSTREAM_TIMEOUT_MS} ms`
        : `Could not reach ${url}: ${err && err.message ? err.message : err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- helpers -----

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJsonBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const modelListCache = new Map();

function trimModelList(providerName, payload) {
  if (providerName === 'typesafe') {
    const models = Array.isArray(payload && payload.models) ? payload.models : [];
    return models.map((m) => ({ id: m.name, name: m.name, description: m.description || '', release_date: m.release_date || '' }));
  }
  const data = Array.isArray(payload && payload.data) ? payload.data : [];
  return data
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context_length: m.context_length || null,
      prompt_usd_per_token: m.pricing && m.pricing.prompt != null ? Number(m.pricing.prompt) : null,
      completion_usd_per_token: m.pricing && m.pricing.completion != null ? Number(m.pricing.completion) : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// -------------------------------------------------------------- routes -----

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/config' && req.method === 'GET') {
    const providers = {};
    for (const [name, p] of Object.entries(PROVIDERS)) {
      if (name === 'laya') {
        const mode = await layaMode();
        providers.laya = {
          label: p.label,
          kind: p.kind,
          configured: mode !== 'none',
          keyHint: null,
          keyName: null,
          baseUrl: p.base(),
          endpoint: mode === 'in-process' ? 'in-process (@receptron/laya, ONNX Runtime)' : p.base() + p.decidePath,
          defaultModel: p.defaultModel,
          mode,
          runtime: { status: layaRuntime.status, error: layaRuntime.error, model: layaRuntime.model, progress: layaRuntime.progress },
          http: { baseUrl: layaBase, reachable: layaHttpProbe.reachable, detail: layaHttpProbe.detail },
        };
        continue;
      }
      const key = resolveKey(p.keyName);
      providers[name] = {
        label: p.label,
        kind: p.kind,
        configured: Boolean(key),
        keyHint: key ? maskKey(key) : null,
        keyName: p.keyName,
        baseUrl: p.base(),
        endpoint: p.base() + p.decidePath,
        defaultModel: p.defaultModel,
      };
    }
    return sendJson(res, 200, {
      ok: true,
      mock: USE_MOCK,
      providers,
      suggestedChatModels: SETTINGS.suggestedChatModels,
      jevUsdPerMillionInputTokens: SETTINGS.jevUsdPerMillionInputTokens,
    });
  }

  if (route === '/api/laya/status' && req.method === 'GET') {
    const mode = await layaMode();
    return sendJson(res, 200, { ok: true, mode, runtime: { status: layaRuntime.status, error: layaRuntime.error, model: layaRuntime.model, progress: layaRuntime.progress }, http: { baseUrl: layaBase, reachable: layaHttpProbe.reachable, detail: layaHttpProbe.detail } });
  }

  if (route === '/api/laya/load' && req.method === 'POST') {
    if (!layaRuntime.module) return sendJson(res, 200, { ok: false, error: '@receptron/laya is not installed. In the game folder run: npm install @receptron/laya  (then restart the server)' });
    loadLayaInProcess().catch(() => {});
    return sendJson(res, 200, { ok: true, status: layaRuntime.status, progress: layaRuntime.progress });
  }

  if (route === '/api/models' && req.method === 'GET') {
    const providerName = url.searchParams.get('provider') || 'openrouter_chat';
    const provider = PROVIDERS[providerName];
    if (!provider) return sendJson(res, 400, { ok: false, error: `Unknown provider "${providerName}"` });
    if (providerName === 'laya' && (await layaMode()) === 'in-process') {
      return sendJson(res, 200, { ok: true, cached: false, models: [{ id: 'laya', name: layaRuntime.model || 'laya (ONNX, in-process)', description: 'open weights, runs inside this server', release_date: '' }] });
    }
    const cacheKey = provider.base() + provider.modelsPath;
    const cached = modelListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
      return sendJson(res, 200, { ok: true, cached: true, models: cached.models });
    }
    const result = await forward(provider, provider.modelsPath, 'GET', undefined, { optionalKey: providerName !== 'typesafe' });
    if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, status: result.status, response: result.response });
    const models = trimModelList(providerName, result.response);
    modelListCache.set(cacheKey, { at: Date.now(), models });
    return sendJson(res, 200, { ok: true, cached: false, models });
  }

  if (route === '/api/decide' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
    const provider = PROVIDERS[body.provider];
    if (!provider) return sendJson(res, 400, { ok: false, error: `Unknown provider "${body.provider}"` });
    if (!body.payload || typeof body.payload !== 'object') return sendJson(res, 400, { ok: false, error: 'Missing "payload" (the upstream request body)' });
    if (body.provider === 'laya') return sendJson(res, 200, await layaDecide(body.payload));
    const result = await forward(provider, provider.decidePath, 'POST', body.payload);
    return sendJson(res, 200, result);
  }

  if (route === '/api/ping' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
    const provider = PROVIDERS[body.provider];
    if (!provider) return sendJson(res, 400, { ok: false, error: `Unknown provider "${body.provider}"` });
    const model = body.model || provider.defaultModel;
    const payload = provider.kind === 'decisions'
      ? {
          model,
          state: 'ping',
          questions: {
            is_ping: { type: 'noul', instructions: 'Is the state exactly the word "ping"?' },
          },
        }
      : {
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          max_tokens: 8,
          temperature: 0,
        };
    const result = body.provider === 'laya' ? await layaDecide(payload) : await forward(provider, provider.decidePath, 'POST', payload);
    return sendJson(res, 200, { ...result, payload });
  }

  return sendJson(res, 404, { ok: false, error: `No API route ${req.method} ${route}` });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${pathname}`);
  }
}

const server = http.createServer(async (req, res) => {
  const started = performance.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else { res.writeHead(405); res.end('Method not allowed'); }
  } catch (err) {
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error' });
  } finally {
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
    }
  }
});

server.listen(PORT, () => {
  const ts = resolveKey('TYPESAFE_API_KEY');
  const or = resolveKey('OPENROUTER_API_KEY');
  console.log('');
  console.log('  Jev plays Dino');
  console.log(`  → open  http://localhost:${PORT}`);
  console.log('');
  console.log(`  TypeSafe (Jev) key : ${ts ? `configured (${maskKey(ts)})` : 'MISSING — paste into config.mjs'}`);
  console.log(`  OpenRouter key     : ${or ? `configured (${maskKey(or)})` : 'MISSING — paste into config.mjs'}`);
  console.log(`  TypeSafe API       : ${typesafeBase}`);
  console.log(`  OpenRouter API     : ${openrouterBase}${USE_MOCK ? '   (MOCK MODE — no real model calls)' : ''}`);
  console.log(`  Laya (local)       : ${layaRuntime.module ? 'in-process runtime installed (@receptron/laya)' : 'in-process runtime not installed'}; HTTP fallback ${layaBase}`);
  console.log('');
  if (LAYA.autoload && layaRuntime.module) loadLayaInProcess().catch(() => {});
});
