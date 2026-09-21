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

if (USE_MOCK) {
  const { startMockUpstream } = await import('./dev/mock-upstream.mjs');
  const mockUrl = await startMockUpstream();
  typesafeBase = mockUrl;
  openrouterBase = mockUrl;
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
};

/**
 * Forward one request upstream, adding the Authorization header.
 * Returns a plain object the browser can render in the live panel; the key is masked.
 */
async function forward(provider, pathname, method, body, { optionalKey = false } = {}) {
  const key = resolveKey(provider.keyName);
  if (!key && !optionalKey) {
    return {
      ok: false,
      status: 401,
      latency_ms: 0,
      error: `${provider.keyName} is not set. Paste it into jev-dino/config.mjs (or export it as an environment variable) and restart the server.`,
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

  if (route === '/api/models' && req.method === 'GET') {
    const providerName = url.searchParams.get('provider') || 'openrouter_chat';
    const provider = PROVIDERS[providerName];
    if (!provider) return sendJson(res, 400, { ok: false, error: `Unknown provider "${providerName}"` });
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
    const result = await forward(provider, provider.decidePath, 'POST', payload);
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
  console.log('');
});
