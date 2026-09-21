// ============================================================================
//  UI glue: start screen, HUD, keyboard, overlay, and wiring game <-> agent <-> panel.
// ============================================================================

import { loadSpriteSheet, RUNNER } from './sprites.js';
import { DinoGame } from './game.js';
import { Agent } from './agent.js';
import { IOPanel, renderProbabilities } from './panel.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const STORAGE_KEY = 'jev-dino-settings-v1';
const HISCORE_KEY = 'jev-dino-hiscores-v1';

const PLAYER_LABELS = {
  typesafe: 'Jev · TypeSafe API',
  openrouter_decisions: 'Jev · via OpenRouter',
  openrouter_chat: 'LLM · via OpenRouter',
  scripted: 'Scripted bot (no model)',
  human: 'Human · keyboard',
};

const app = {
  config: null,
  game: null,
  agent: null,
  panel: null,
  settings: null,
  orModels: new Map(),
  hiScores: {},
  panelClosedByUser: false,
  bannerTimer: 0,
};

// ------------------------------------------------------------------ boot --

export async function initUI() {
  window.jevDino = app; // handy for debugging from the console
  const sprite = await loadSpriteSheet();
  app.panel = new IOPanel($('#panel'));
  app.game = new DinoGame($('#game'), sprite, { onCrash: onCrash });
  app.hiScores = readJson(HISCORE_KEY, {});

  bindSetup();
  bindGameControls();
  bindKeyboard();
  bindPanelToggle();

  applySettings(readJson(STORAGE_KEY, null));
  await loadConfig();
  loadOpenRouterModels(); // async, best effort
}

function readJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

// ---------------------------------------------------------------- config --

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    app.config = await res.json();
  } catch (err) {
    setHint(`Could not reach the local server (${err.message}). Start it with: node server.mjs`, true);
    return;
  }
  const { providers, mock } = app.config;
  $('#mockRibbon').hidden = !mock;

  const keyFor = { typesafe: providers.typesafe, openrouter_decisions: providers.openrouter_decisions, openrouter_chat: providers.openrouter_chat };
  for (const [provider, info] of Object.entries(keyFor)) {
    const card = $(`.player[data-provider="${provider}"]`);
    const stat = card.querySelector('.keystat');
    const radio = card.querySelector('input[type=radio]');
    if (info.configured) {
      stat.textContent = `key ${info.keyHint}`;
      stat.className = 'keystat ok';
      radio.disabled = false;
      card.classList.remove('disabled');
    } else {
      stat.innerHTML = `key missing — paste <code>${info.keyName}</code> into <code>jev-dino/config.mjs</code> and restart`;
      stat.className = 'keystat missing';
      radio.disabled = true;
      card.classList.add('disabled');
      if (radio.checked) { radio.checked = false; }
    }
    card.querySelector('.ping').disabled = !info.configured;
  }
  // Default model names from the server unless the user typed their own.
  if (!$('#modelTypesafe').value) $('#modelTypesafe').value = providers.typesafe.defaultModel;
  if (!$('#modelOrJev').value) $('#modelOrJev').value = providers.openrouter_decisions.defaultModel;
  if (!$('#modelOrChat').value) $('#modelOrChat').value = providers.openrouter_chat.defaultModel;
  fillDatalist(app.config.suggestedChatModels.map((id) => ({ id, name: id })));

  if (!$$('input[name=player]').some((r) => r.checked)) {
    const firstEnabled = $$('input[name=player]').find((r) => !r.disabled);
    if (firstEnabled) firstEnabled.checked = true;
  }
  updateStartButton();
}

async function loadOpenRouterModels() {
  const info = $('#orModelInfo');
  try {
    const res = await fetch('/api/models?provider=openrouter_chat');
    const json = await res.json();
    if (!json.ok) { info.textContent = `model list unavailable (${json.error || 'error'}) — type any OpenRouter model id`; return; }
    app.orModels = new Map(json.models.map((m) => [m.id, m]));
    fillDatalist(json.models);
    info.textContent = `${json.models.length} models loaded from OpenRouter — type to search`;
    showModelPricing();
  } catch (err) {
    info.textContent = `model list unavailable (${err.message}) — type any OpenRouter model id`;
  }
}

function fillDatalist(models) {
  const dl = $('#orModels');
  dl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    if (m.name && m.name !== m.id) opt.label = m.name;
    dl.appendChild(opt);
  }
}

function showModelPricing() {
  const id = $('#modelOrChat').value.trim();
  const m = app.orModels.get(id);
  const el = $('#orModelPricing');
  if (!m) { el.textContent = ''; return; }
  const inM = m.prompt_usd_per_token != null ? `$${(m.prompt_usd_per_token * 1e6).toFixed(2)}/M in` : '';
  const outM = m.completion_usd_per_token != null ? `$${(m.completion_usd_per_token * 1e6).toFixed(2)}/M out` : '';
  el.textContent = [m.name, inM, outM, m.context_length ? `${(m.context_length / 1000).toFixed(0)}k ctx` : ''].filter(Boolean).join(' · ');
}

// ----------------------------------------------------------------- setup --

function bindSetup() {
  $('#speed').addEventListener('input', () => { $('#speedValue').textContent = Number($('#speed').value).toFixed(1); });
  $('#scriptedLatency').addEventListener('input', () => { $('#scriptedLatencyValue').textContent = $('#scriptedLatency').value; });
  $('#modelOrChat').addEventListener('input', showModelPricing);
  $$('input[name=player]').forEach((r) => r.addEventListener('change', updateStartButton));
  $('#btnStart').addEventListener('click', () => startRun());
  $$('.ping').forEach((btn) => btn.addEventListener('click', () => ping(btn.dataset.provider)));
  // Clicking anywhere on a card selects it (inputs inside stay usable).
  $$('.player').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('input, button, select, label.inline')) return;
    const radio = card.querySelector('input[type=radio]');
    if (!radio.disabled) { radio.checked = true; updateStartButton(); }
  }));
}

function selectedPlayer() {
  const r = $$('input[name=player]').find((x) => x.checked);
  return r ? r.value : null;
}

function updateStartButton() {
  const p = selectedPlayer();
  $('#btnStart').disabled = !p;
  $$('.player').forEach((c) => c.classList.toggle('selected', c.dataset.provider === p));
  if (!p) setHint('Pick a player. Providers without a key are greyed out until you paste one into config.mjs.', false);
  else setHint(p === 'human' ? 'Space / ↑ to jump, ↓ to duck.' : 'The game starts immediately and the first calls appear in the Model I/O panel.', false);
}

function setHint(text, isError) {
  const el = $('#setupHint');
  el.textContent = text;
  el.classList.toggle('error', Boolean(isError));
}

async function ping(provider) {
  const out = $(`.ping-result[data-provider="${provider}"]`);
  const model = provider === 'typesafe' ? $('#modelTypesafe').value.trim() : provider === 'openrouter_decisions' ? $('#modelOrJev').value.trim() : $('#modelOrChat').value.trim();
  out.textContent = 'calling…';
  out.className = 'ping-result';
  try {
    const res = await fetch('/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model }) });
    const json = await res.json();
    if (json.ok) {
      const served = json.response && json.response.model ? ` · model ${json.response.model}` : '';
      out.textContent = `OK · ${json.latency_ms} ms${served}`;
      out.className = 'ping-result ok';
    } else {
      const detail = json.response && (json.response.error && (json.response.error.message || json.response.error) || json.response.detail || json.response.message);
      out.textContent = `${json.error || 'failed'}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 240);
      out.className = 'ping-result bad';
    }
  } catch (err) {
    out.textContent = `failed: ${err.message}`;
    out.className = 'ping-result bad';
  }
}

function readSettings() {
  return {
    player: selectedPlayer(),
    models: {
      typesafe: $('#modelTypesafe').value.trim() || 'jev-latest',
      openrouter_decisions: $('#modelOrJev').value.trim() || 'typesafe/jev-1.13',
      openrouter_chat: $('#modelOrChat').value.trim() || 'openai/gpt-4o-mini',
    },
    scriptedLatency: Number($('#scriptedLatency').value),
    speed: Number($('#speed').value),
    accelerate: $('#accelerate').checked,
    stateFormat: $('#stateFormat').value,
    timingAssist: $('#timingAssist').checked,
    dangerQuestion: $('#dangerQuestion').checked,
    cadence: $('#cadence').value,
    intervalMs: Math.min(5000, Math.max(30, Number($('#intervalMs').value) || 100)),
    showHitboxes: $('#showHitboxes').checked,
  };
}

function applySettings(s) {
  if (!s) { $('#speedValue').textContent = Number($('#speed').value).toFixed(1); $('#scriptedLatencyValue').textContent = $('#scriptedLatency').value; return; }
  if (s.models) {
    if (s.models.typesafe) $('#modelTypesafe').value = s.models.typesafe;
    if (s.models.openrouter_decisions) $('#modelOrJev').value = s.models.openrouter_decisions;
    if (s.models.openrouter_chat) $('#modelOrChat').value = s.models.openrouter_chat;
  }
  if (s.scriptedLatency != null) $('#scriptedLatency').value = s.scriptedLatency;
  if (s.speed != null) $('#speed').value = s.speed;
  if (s.accelerate != null) $('#accelerate').checked = s.accelerate;
  if (s.stateFormat) $('#stateFormat').value = s.stateFormat;
  if (s.timingAssist != null) $('#timingAssist').checked = s.timingAssist;
  if (s.dangerQuestion != null) $('#dangerQuestion').checked = s.dangerQuestion;
  if (s.cadence) $('#cadence').value = s.cadence;
  if (s.intervalMs != null) $('#intervalMs').value = s.intervalMs;
  if (s.showHitboxes != null) $('#showHitboxes').checked = s.showHitboxes;
  if (s.player) { const r = $(`input[name=player][value="${s.player}"]`); if (r) r.checked = true; }
  $('#speedValue').textContent = Number($('#speed').value).toFixed(1);
  $('#scriptedLatencyValue').textContent = $('#scriptedLatency').value;
}

// ------------------------------------------------------------------- run --

function startRun() {
  const s = readSettings();
  if (!s.player) return;
  app.settings = s;
  writeJson(STORAGE_KEY, s);

  stopAgent();
  app.game.configure({ speed: s.speed, accelerate: s.accelerate, showHitboxes: s.showHitboxes });

  $('#setup').hidden = true;
  $('#gameWrap').hidden = false;
  $('#overlay').hidden = true;
  $('#pills').hidden = false;
  hideBanner();
  resetHud();

  const model = s.player === 'human' ? '—' : s.player === 'scripted' ? 'scripted rule' : s.models[s.player];
  const providerInfo = app.config && app.config.providers[s.player];
  app.panel.setSession({
    providerLabel: PLAYER_LABELS[s.player],
    model,
    endpoint: providerInfo ? providerInfo.endpoint : s.player === 'scripted' ? '(rule of thumb in the browser)' : '(no model calls)',
    method: providerInfo ? 'POST' : '',
    stateFormat: s.stateFormat,
    cadence: s.player === 'human' ? '' : (effectiveCadence(s) === 'interval' ? `a new call every ${s.intervalMs} ms, answers applied as they land` : 'one call at a time'),
    note: s.player === 'scripted' ? 'The scripted bot applies a fixed if/else to the same state, with artificial latency. It is the baseline, not a model.' : s.player === 'human' ? 'Keyboard: Space / ↑ jump, ↓ duck.' : '',
  });
  const cadence = effectiveCadence(s) === 'interval' ? `a call every ${s.intervalMs} ms` : 'one call at a time';
  app.panel.divider(`new run · ${PLAYER_LABELS[s.player]} · ${model} · speed ${s.speed}${s.accelerate ? ' + acceleration' : ''} · ${cadence}`);
  if (!app.panelClosedByUser && s.player !== 'human') app.panel.setCollapsed(false);
  syncPanelToggle();

  $('#pillPlayer').textContent = PLAYER_LABELS[s.player];
  $('#pillModel').textContent = model;
  $('#pillLatency').textContent = '— ms';
  $('#pillRate').textContent = '— calls/s';
  $('#controlsHint').textContent = s.player === 'human' ? 'Space / ↑ jump · ↓ duck · P pause · Esc settings' : 'P pause · Esc settings · Space restarts after a crash';
  $('#hudDangerLabel').textContent = s.dangerQuestion && s.player !== 'human' ? "danger (model's score, 0–3)" : 'danger';

  app.game.start();

  if (s.player !== 'human') {
    const pricing = pricingFor(s);
    app.agent = new Agent({
      provider: s.player,
      model: s.models[s.player] || model,
      game: app.game,
      panel: app.panel,
      options: {
        stateFormat: s.stateFormat,
        timingAssist: s.timingAssist,
        dangerQuestion: s.dangerQuestion,
        cadence: effectiveCadence(s),
        intervalMs: s.intervalMs,
        simulatedLatencyMs: s.scriptedLatency,
        pricing,
      },
      hooks: { onDecision: onDecision, onError: onAgentError },
    });
    app.agent.start();
  }
  $('#btnPause').textContent = 'Pause';
}

function effectiveCadence(s) {
  if (s.cadence === 'interval' || s.cadence === 'sequential') return s.cadence;
  return s.player === 'openrouter_chat' ? 'sequential' : 'interval';
}

function pricingFor(s) {
  const out = { jevUsdPerMillionInputTokens: app.config ? app.config.jevUsdPerMillionInputTokens : 0.042 };
  if (s.player === 'openrouter_chat') {
    const m = app.orModels.get(s.models.openrouter_chat);
    if (m) { out.promptUsdPerToken = m.prompt_usd_per_token || 0; out.completionUsdPerToken = m.completion_usd_per_token || 0; }
  } else if (s.player === 'openrouter_decisions') {
    const m = app.orModels.get(s.models.openrouter_decisions);
    if (m && m.prompt_usd_per_token != null) out.jevUsdPerMillionInputTokens = m.prompt_usd_per_token * 1e6;
  }
  return out;
}

function stopAgent() {
  if (app.agent) { app.agent.stop(); app.agent = null; }
}

function onCrash(summary) {
  const stats = app.agent ? app.agent.statsSummary() : null;
  stopAgent();
  const key = app.settings ? `${app.settings.player}:${app.settings.player === 'human' ? '' : app.settings.models[app.settings.player] || ''}` : 'unknown';
  app.hiScores[key] = Math.max(app.hiScores[key] || 0, summary.score);
  writeJson(HISCORE_KEY, app.hiScores);

  $('#ovScore').textContent = summary.score;
  $('#ovHigh').textContent = app.hiScores[key];
  $('#ovCalls').textContent = stats ? stats.calls : '—';
  $('#ovLatency').textContent = stats && stats.avgLatencyMs != null ? `${stats.avgLatencyMs} ms` : '—';
  const secs = (summary.runningTimeMs / 1000).toFixed(1);
  const into = summary.crashedInto ? `Crashed into a ${summary.crashedInto}` : 'Crashed';
  const rate = stats && stats.calls ? ` · ${stats.calls} decisions in ${secs} s (${(stats.calls / Math.max(0.1, summary.runningTimeMs / 1000)).toFixed(1)} per second)` : ` after ${secs} s`;
  const jumps = ` · ${summary.jumps} jumps, ${summary.ducks} ducks`;
  $('#ovReason').textContent = `${into} at speed ${summary.speed.toFixed(1)}${rate}${jumps}.`;
  $('#overlay').hidden = false;
  app.panel.divider(`run ended · score ${summary.score} · ${into.toLowerCase()}`);
}

function onAgentError(message, fatal) {
  showBanner(fatal ? `Stopped: ${message}` : message, fatal ? 'fatal' : 'warn');
}

// ------------------------------------------------------------------- HUD --

function resetHud() {
  $('#hudAction').textContent = '—';
  $('#hudAction').className = 'hud-action';
  $('#hudProbs').innerHTML = '';
  $('#hudDangerBar').style.width = '0%';
  $('#hudDanger').textContent = '—';
  $('#hudLatency').textContent = '—';
  $('#hudLatencySub').textContent = '';
  $('#hudCalls').textContent = '0';
  $('#hudCallsSub').textContent = '';
  $('#hudState').textContent = app.settings && app.settings.player === 'human' ? 'You are playing; no model is called.' : 'waiting for the first call…';
}

function onDecision({ parsed, error, stale, state, upstreamMs, stats }) {
  const actionEl = $('#hudAction');
  if (parsed) {
    actionEl.textContent = parsed.action.toUpperCase() + (stale ? ' (stale)' : '');
    actionEl.className = `hud-action ${parsed.action}${stale ? ' stale' : ''}`;
    $('#hudProbs').innerHTML = renderProbabilities({ ...parsed, danger: null, reason: parsed.reason && parsed.reason.length < 80 ? parsed.reason : '', reasoning: null });
    if (parsed.danger && parsed.danger.score != null) {
      const d = Number(parsed.danger.score);
      $('#hudDangerBar').style.width = `${Math.min(100, (d / 3) * 100).toFixed(0)}%`;
      $('#hudDangerBar').dataset.level = String(Math.round(d));
      $('#hudDanger').textContent = `${d.toFixed(2)} / 3`;
    }
  } else {
    actionEl.textContent = 'ERROR';
    actionEl.className = 'hud-action err';
    $('#hudProbs').innerHTML = `<div class="hud-error">${escapeHtml(error || 'unknown error')}</div>`;
  }
  $('#hudLatency').textContent = `${Math.round(upstreamMs)} ms`;
  $('#hudLatencySub').textContent = stats.avgLatencyMs != null ? `avg ${stats.avgLatencyMs} · p50 ${stats.p50LatencyMs} · max ${stats.maxLatencyMs} ms` : '';
  $('#hudCalls').textContent = String(stats.calls);
  $('#hudCallsSub').textContent = `${stats.callsPerSecond}/s · ${stats.tokensIn.toLocaleString()} tokens in · ${stats.costUsd < 0.01 ? '$' + stats.costUsd.toFixed(5) : '$' + stats.costUsd.toFixed(3)}${stats.errors ? ` · ${stats.errors} errors` : ''}`;
  $('#hudState').textContent = describeState(state);
  $('#pillLatency').textContent = `${Math.round(upstreamMs)} ms (avg ${stats.avgLatencyMs != null ? stats.avgLatencyMs : '—'})`;
  $('#pillRate').textContent = `${stats.callsPerSecond} calls/s`;
}

function describeState(state) {
  if (!state) return '—';
  const o = state.nearest_obstacle;
  const dino = `dino ${state.dino.state}${state.dino.state === 'jumping' ? ` (${state.dino.height_above_ground_px} px up, lands in ${state.dino.lands_in_ms} ms)` : ''} at ${state.speed_px_per_s} px/s`;
  if (!o) return `${dino} · no obstacle in sight · latency ${state.timing.your_recent_latency_ms} ms`;
  const what = o.kind === 'pterodactyl' ? `pterodactyl ${o.flying_height}` : `${o.count > 1 ? o.count + ' × ' : ''}${o.size} cactus`;
  const timing = o.jump_timing ? ` · jump_timing: ${o.jump_timing}` : state.timing.jump_window_ms ? ` · jump window ${state.timing.jump_window_ms.start_ms}→${state.timing.jump_window_ms.end_ms} ms` : '';
  const next = state.next_obstacle ? ` · next: ${state.next_obstacle.kind === 'pterodactyl' ? 'pterodactyl' : state.next_obstacle.size + ' cactus'} in ${state.next_obstacle.arrives_in_ms} ms` : '';
  return `${dino} · ${what}, ${o.distance_px} px ahead, arrives in ${o.arrives_in_ms} ms (${o.arrives_in_ms_when_answer_lands} ms after the answer lands)${timing}${next}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showBanner(text, kind) {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = false;
  clearTimeout(app.bannerTimer);
  if (kind !== 'fatal') app.bannerTimer = setTimeout(hideBanner, 5000);
}
function hideBanner() { $('#banner').hidden = true; }

// -------------------------------------------------------------- controls --

function bindGameControls() {
  $('#btnPause').addEventListener('click', togglePause);
  $('#btnRestart').addEventListener('click', () => startRun());
  $('#btnAgain').addEventListener('click', () => startRun());
  $('#btnSettings').addEventListener('click', backToSettings);
  $('#btnChange').addEventListener('click', backToSettings);
  $('#game').addEventListener('click', (e) => {
    if (app.game.status !== 'crashed') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 600;
    const y = ((e.clientY - rect.top) / rect.height) * 150;
    const r = app.game.restartButtonRect();
    if (x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 6 && y <= r.y + r.h + 6) startRun();
  });
}

function togglePause() {
  if (app.game.status === 'running') { app.game.pause(); $('#btnPause').textContent = 'Resume'; }
  else if (app.game.status === 'paused') { app.game.resume(); $('#btnPause').textContent = 'Pause'; }
}

function backToSettings() {
  stopAgent();
  app.game.reset();
  $('#overlay').hidden = true;
  $('#gameWrap').hidden = true;
  $('#setup').hidden = false;
  $('#pills').hidden = true;
  hideBanner();
}

function bindKeyboard() {
  const isTyping = (e) => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const inGame = !$('#gameWrap').hidden;
    if (!inGame) return;
    const human = app.settings && app.settings.player === 'human';
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
      e.preventDefault();
      if (app.game.status === 'crashed') { startRun(); return; }
      if (human && !e.repeat) app.game.jump();
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      if (human) app.game.setDuck(true);
    } else if (e.code === 'KeyP') {
      togglePause();
    } else if (e.code === 'Escape') {
      backToSettings();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (isTyping(e)) return;
    const human = app.settings && app.settings.player === 'human';
    if (!human || $('#gameWrap').hidden) return;
    if (e.code === 'Space' || e.code === 'ArrowUp') app.game.endJump();
    if (e.code === 'ArrowDown') app.game.setDuck(false);
  });
}

function bindPanelToggle() {
  $('#btnPanelToggle').addEventListener('click', () => {
    const open = app.panel.collapsed;
    app.panel.setCollapsed(!open);
    app.panelClosedByUser = !open ? false : true;
    syncPanelToggle();
  });
  $('#btnPanelClose').addEventListener('click', () => {
    app.panel.setCollapsed(true);
    app.panelClosedByUser = true;
    syncPanelToggle();
  });
}

function syncPanelToggle() {
  const btn = $('#btnPanelToggle');
  const open = !app.panel.collapsed;
  btn.textContent = open ? 'Hide Model I/O ◂' : 'Show Model I/O ▸';
  btn.setAttribute('aria-expanded', String(open));
}

export { RUNNER };
