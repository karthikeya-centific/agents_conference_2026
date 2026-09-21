// ============================================================================
//  The agent: turns a game snapshot into model input, calls the chosen model
//  through the local server, parses the typed answer and presses the key.
//
//  Every call is stateless. Nothing is remembered between calls: the full
//  situation and the rules travel with each request. That is exactly how a
//  System One model like Jev is meant to be used.
// ============================================================================

import { TREX } from './sprites.js';
import { FRAME_MS, trexHitsObstacle } from './game.js';

export const ACTIONS = ['jump', 'duck', 'run'];

const LATENCY_GUESS_MS = { typesafe: 250, openrouter_decisions: 350, openrouter_chat: 1500, scripted: 150 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------ the state ----

/**
 * Build the model-facing state from a game snapshot.
 * Physics facts (distances, times, whether a jump would clear) are computed here in code;
 * the model only makes the judgment call. `latencyMs` is the model's recent latency,
 * used to express times "when your answer lands".
 */
export function buildState(snapshot, { latencyMs, timingAssist, jumpProfile }) {
  const { trex, speed } = snapshot;
  const profile = jumpProfile(speed);
  const dinoState = trex.jumping ? 'jumping' : trex.ducking ? 'ducking' : 'running';

  const describe = (o, detailed) => {
    const relSpeed = speed + (o.speedOffset || 0); // px per frame towards the dino
    const distancePx = o.x - (trex.x + TREX.width);
    const arrivesMs = (distancePx / relSpeed) * FRAME_MS;
    const out = {};
    if (o.type === 'pterodactyl') {
      out.kind = 'pterodactyl';
      out.flying_height = o.y >= 100 ? 'low (at ground level, same height as the dino)' : o.y >= 75 ? 'mid (at head height of a standing dino)' : 'high (above a standing dino)';
    } else {
      out.kind = 'cactus';
      out.size = o.type === 'cactusLarge' ? 'large' : 'small';
      out.count = o.size;
    }
    out.width_px = o.width;
    out.height_px = o.height;
    out.distance_px = r0(distancePx);
    out.arrives_in_ms = r0(arrivesMs);
    if (!detailed) return out;

    out.arrives_in_ms_when_answer_lands = r0(arrivesMs - latencyMs);
    // Jump window, by simulation with the real jump curve and Chromium's collision boxes:
    // for each possible start delay after the answer lands, would the dino get through?
    const sim = simulateJumpWindow(o, snapshot, profile, latencyMs, relSpeed);
    const c = arrivesMs - latencyMs;
    let window = null;
    if (sim.firstSafeDelay != null) {
      window = { start_ms: r0(c - sim.firstSafeDelay * FRAME_MS), end_ms: r0(c - sim.lastSafeDelay * FRAME_MS) };
    }
    if (timingAssist) {
      if (trex.jumping) out.jump_timing = 'airborne (already in a jump)';
      else if (distancePx < 0) out.jump_timing = o.type === 'pterodactyl' && o.y === 75 ? 'passing_overhead (it is above the dino right now)' : 'passing (the obstacle is beside the dino)';
      else if (sim.runsUnder) out.jump_timing = 'not_needed (it passes above a running dino)';
      else if (sim.alreadyPassed) out.jump_timing = 'too_late (it reaches the dino before your answer lands)';
      else if (sim.safeNow) out.jump_timing = 'now';
      else if (sim.firstSafeDelay != null) out.jump_timing = 'too_early';
      else out.jump_timing = 'too_late';
    }
    out._window = window; // stripped before sending; used by the timing block below
    return out;
  };

  const [first, second] = snapshot.obstacles;
  const nearest = first ? describe(first, true) : null;
  const next = second ? describe(second, false) : null;
  const window = nearest ? nearest._window : null;
  if (nearest) delete nearest._window;

  const state = {
    frame: snapshot.frame,
    score: snapshot.score,
    speed_px_per_frame: r1(speed),
    speed_px_per_s: r0(speed * 60),
    dino: {
      state: dinoState,
      x_px: trex.x,
      height_above_ground_px: trex.heightAboveGround,
      standing_height_px: TREX.height,
      ducking_height_px: TREX.heightDuck,
    },
    nearest_obstacle: nearest,
    next_obstacle: next,
    timing: {
      your_recent_latency_ms: r0(latencyMs),
      jump_airtime_ms: profile.airtimeMs,
      jump_apex_px: profile.apexPx,
    },
  };
  if (trex.jumping) state.dino.lands_in_ms = trex.landsInMs;
  if (!timingAssist && window) state.timing.jump_window_ms = window;
  return state;
}

/**
 * Simulate, frame by frame, a full jump started `d` frames after the answer lands,
 * for d = 0..MAX_DELAY, against this obstacle moving at relSpeed. Uses the same jump
 * curve and collision boxes as the game, so "safe" means the game would not crash.
 */
const MAX_DELAY_FRAMES = 90;
const JITTER_FRAMES = 1.5;
function simulateJumpWindow(o, snapshot, profile, latencyMs, relSpeed) {
  const trexX = snapshot.trex.x;
  const groundY = snapshot.groundY;
  const running = TREX.collisionBoxes.running;
  const xAtArrival = o.x - relSpeed * (latencyMs / FRAME_MS);
  const heights = profile.heights;

  // Walk the frames from `startX` until the obstacle is behind the dino.
  // heightAt(k) gives the dino's height in frame k (0 = on the ground).
  const survives = (startX, heightAt) => {
    for (let k = 0; k <= 600; k++) {
      const ox = startX - relSpeed * k;
      if (ox + o.width <= trexX) return true; // obstacle has passed
      if (trexHitsObstacle(trexX, groundY - heightAt(k), running, o, ox)) return false;
    }
    return true;
  };
  // Would a running dino get past it without doing anything (e.g. a high pterodactyl)? Judged from now.
  const runsUnder = survives(o.x, () => 0);
  // The obstacle reaches the dino before the answer lands: whatever we answer comes too late.
  if (!runsUnder && xAtArrival < trexX + TREX.width) {
    return { safeNow: false, firstSafeDelay: null, lastSafeDelay: null, runsUnder: false, alreadyPassed: true };
  }
  // Real timing jitters by a frame or two (rAF quantisation, latency noise): a jump only counts as
  // safe if it also survives with the obstacle shifted by ±JITTER_FRAMES.
  const shift = relSpeed * JITTER_FRAMES;
  const safeWithDelay = (d) => {
    const heightAt = (k) => (k < d || k - d >= heights.length ? 0 : heights[k - d]);
    return survives(xAtArrival, heightAt) && survives(xAtArrival + shift, heightAt) && survives(xAtArrival - shift, heightAt);
  };

  let firstSafeDelay = null;
  let lastSafeDelay = null;
  if (!runsUnder) {
    for (let d = 0; d <= MAX_DELAY_FRAMES; d++) {
      if (safeWithDelay(d)) {
        if (firstSafeDelay == null) firstSafeDelay = d;
        lastSafeDelay = d;
      } else if (firstSafeDelay != null) {
        break; // the safe window is one contiguous interval
      }
    }
  }
  return { safeNow: firstSafeDelay === 0, firstSafeDelay, lastSafeDelay, runsUnder, alreadyPassed: false };
}

/** The same facts as prose, for the "plain text" state format. */
export function toProse(state) {
  const parts = [];
  parts.push(`Frame ${state.frame}, score ${state.score}. The dino is ${state.dino.state} at ${state.speed_px_per_s} px/s (${state.speed_px_per_frame} px per frame)` +
    (state.dino.state === 'jumping' ? `, ${state.dino.height_above_ground_px} px above the ground, landing in ${state.dino.lands_in_ms} ms.` : '.') +
    ` Standing it is ${state.dino.standing_height_px} px tall, ducking ${state.dino.ducking_height_px} px.`);
  const o = state.nearest_obstacle;
  if (!o) parts.push('There is no obstacle in sight.');
  else {
    const what = o.kind === 'pterodactyl' ? `a pterodactyl flying ${o.flying_height}` : o.count > 1 ? `a group of ${o.count} ${o.size} cacti` : `a ${o.size} cactus`;
    parts.push(`Nearest obstacle: ${what}, ${o.width_px} px wide and ${o.height_px} px tall, ${o.distance_px} px ahead; it arrives in ${o.arrives_in_ms} ms, i.e. about ${o.arrives_in_ms_when_answer_lands} ms after your answer lands.` +
      (o.jump_timing ? ` Jump timing: ${o.jump_timing}.` : ''));
  }
  const n = state.next_obstacle;
  if (n) {
    const what = n.kind === 'pterodactyl' ? `a pterodactyl flying ${n.flying_height}` : n.count > 1 ? `a group of ${n.count} ${n.size} cacti` : `a ${n.size} cactus`;
    parts.push(`Behind it: ${what}, ${n.distance_px} px ahead, arriving in ${n.arrives_in_ms} ms.`);
  }
  const t = state.timing;
  parts.push(`Your recent latency is ${t.your_recent_latency_ms} ms. A jump lasts ${t.jump_airtime_ms} ms and reaches ${t.jump_apex_px} px.` +
    (t.jump_window_ms ? ` A jump clears the nearest obstacle only if started when it is between ${t.jump_window_ms.start_ms} and ${t.jump_window_ms.end_ms} ms away (after your latency).` : ''));
  return parts.join(' ');
}

// -------------------------------------------------------- the questions ----

function rulesText(opts) {
  return [
    'You are the reflexes of the T-Rex in the Chrome dinosaur game. The game presses the key you choose the instant your answer arrives, then asks again.',
    opts.timingAssist
      ? 'jump_timing says whether a jump started when your answer lands clears the nearest obstacle: "now" means jump this instant; "too_early" means keep running and wait; "too_late" means jump anyway, it is the last chance; "not_needed" means it passes above a running dino; "airborne" or "passing" means no jump is possible.'
      : 'A jump lasts jump_airtime_ms and cannot be cancelled, so a jump started too early lands on the obstacle. Jump only when arrives_in_ms_when_answer_lands is inside jump_window_ms (between its start_ms and end_ms).',
    'Cacti and a pterodactyl flying low must be jumped over. A pterodactyl at mid height must be ducked under: choose duck when it is close (within about 700 ms), even while still in the air from a previous jump, and stay ducked while it is passing overhead. A pterodactyl flying high is harmless: keep running. Never duck for a cactus.',
  ].join(' ');
}

export function buildQuestions(opts) {
  const questions = {
    action: {
      type: 'choice',
      instructions: `${rulesText(opts)} Which input should the game press right now?`,
      criteria: {
        jump: 'Press the jump key now.',
        duck: 'Hold the duck key now (crouch under a pterodactyl at mid height).',
        run: 'Press nothing: keep running.',
      },
    },
  };
  if (opts.dangerQuestion) {
    questions.danger = {
      type: 'score',
      instructions: 'How dangerous is the situation for the dino right now?',
      criteria: [
        'safe: nothing is close',
        'caution: an obstacle is approaching but there is time',
        'urgent: the obstacle arrives within about one jump duration; an input is needed now or very soon',
        'critical: a collision is imminent or unavoidable',
      ],
    };
  }
  return questions;
}

export function buildDecisionPayload(model, state, opts) {
  return {
    model,
    state: opts.stateFormat === 'text' ? toProse(state) : state,
    questions: buildQuestions(opts),
  };
}

export function buildChatPayload(model, state, opts) {
  const system = `${rulesText(opts)} Respond with a single JSON object and nothing else: {"action": "jump" | "duck" | "run", "danger": 0-3 (0 safe, 1 caution, 2 urgent, 3 critical), "reason": "at most ten words"}.`;
  const user = opts.stateFormat === 'text' ? toProse(state) : `Game state:\n${JSON.stringify(state, null, 2)}`;
  const compat = opts.compatLevel || 0;
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 120,
  };
  if (compat < 2) payload.temperature = 0;
  if (compat < 1) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'dino_action',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ACTIONS },
            danger: { type: 'integer', minimum: 0, maximum: 3 },
            reason: { type: 'string' },
          },
          required: ['action', 'danger', 'reason'],
          additionalProperties: false,
        },
      },
    };
  }
  return payload;
}

// ------------------------------------------------------------- parsing ----

export function parseDecisionResponse(json) {
  const a = json && json.answers && json.answers.action;
  if (!a || a.type !== 'choice' || !ACTIONS.includes(a.choice)) {
    throw new Error(`Unexpected answer shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const d = json.answers.danger;
  return {
    action: a.choice,
    confidence: a.confidence,
    probabilities: a.probabilities,
    danger: d && d.type === 'score' ? { score: d.score, confidence: d.confidence, probabilities: d.probabilities, legend: d.legend } : null,
    tokensIn: json.usage ? json.usage.input_tokens || 0 : 0,
    tokensOut: json.usage ? json.usage.output_tokens || 0 : 0,
    model: json.model,
  };
}

export function parseChatResponse(json) {
  const choice = json && json.choices && json.choices[0];
  const message = choice && choice.message;
  let content = message ? message.content : '';
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  if (typeof content !== 'string') content = String(content || '');
  const cleaned = content.replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in the model reply: ${cleaned.slice(0, 160) || '(empty)'}`);
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { throw new Error(`Reply is not valid JSON: ${match[0].slice(0, 160)}`); }
  const action = String(parsed.action || '').trim().toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`Invalid action "${parsed.action}" (expected jump | duck | run)`);
  const danger = Number.isFinite(Number(parsed.danger)) ? Math.max(0, Math.min(3, Number(parsed.danger))) : null;
  const probabilities = {}; ACTIONS.forEach((k) => { probabilities[k] = k === action ? 1 : 0; });
  return {
    action,
    confidence: null,
    probabilities,
    danger: danger == null ? null : { score: danger, confidence: null, probabilities: null },
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    reasoning: message && typeof message.reasoning === 'string' ? message.reasoning : null,
    tokensIn: json.usage ? json.usage.prompt_tokens || 0 : 0,
    tokensOut: json.usage ? json.usage.completion_tokens || 0 : 0,
    model: json.model,
  };
}

// ------------------------------------------------------- scripted bot ----

/** A plain if/else on the same state. Not a model — a baseline for the demo. */
export function scriptedDecide(state) {
  const o = state.nearest_obstacle;
  if (!o) return { action: 'run', danger: 0 };
  if (o.kind === 'pterodactyl' && o.flying_height.startsWith('mid')) {
    const soon = o.arrives_in_ms_when_answer_lands < 700; // includes "passing overhead" (negative)
    return { action: soon ? 'duck' : 'run', danger: soon ? 2 : 1 };
  }
  if (state.dino.state === 'jumping') return { action: 'run', danger: 1 };
  if (o.kind === 'pterodactyl' && o.flying_height.startsWith('high')) return { action: 'run', danger: 1 };
  let timing = o.jump_timing;
  if (!timing) {
    const w = state.timing.jump_window_ms;
    const c = o.arrives_in_ms_when_answer_lands;
    timing = !w ? 'cannot' : c > w.start_ms ? 'too_early' : c >= w.end_ms ? 'now' : 'too_late';
  }
  if (timing === 'now') return { action: 'jump', danger: 2 };
  if (timing === 'too_late') return { action: 'jump', danger: 3 };
  if (timing && timing.startsWith('not_needed')) return { action: 'run', danger: 1 };
  return { action: 'run', danger: o.arrives_in_ms_when_answer_lands < 1200 ? 1 : 0 };
}

function fakeDistribution(winner, confidence) {
  const out = {};
  const rest = ACTIONS.filter((k) => k !== winner);
  const leftover = 1 - confidence;
  out[rest[0]] = Number((leftover * 0.6).toFixed(3));
  out[rest[1]] = Number((leftover - out[rest[0]]).toFixed(3));
  out[winner] = Number((1 - out[rest[0]] - out[rest[1]]).toFixed(3));
  return out;
}

// --------------------------------------------------------------- Agent ----

const MAX_IN_FLIGHT = 8;

export class Agent {
  /**
   * @param {object} p
   * @param {'typesafe'|'openrouter_decisions'|'openrouter_chat'|'scripted'} p.provider
   * @param {string} p.model
   * @param {import('./game.js').DinoGame} p.game
   * @param {object} p.panel   IOPanel
   * @param {object} p.options { stateFormat, timingAssist, dangerQuestion, cadence: 'sequential'|'interval', intervalMs, simulatedLatencyMs, pricing }
   * @param {object} p.hooks   { onDecision(info), onError(message, fatal) }
   */
  constructor({ provider, model, game, panel, options = {}, hooks = {} }) {
    this.provider = provider;
    this.model = model;
    this.game = game;
    this.panel = panel;
    this.options = { stateFormat: 'json', timingAssist: true, dangerQuestion: true, cadence: 'sequential', intervalMs: 100, simulatedLatencyMs: 150, pricing: {}, ...options };
    this.hooks = hooks;
    this.running = false;
    this.runId = 0;
    this.timer = 0;
    this.inFlight = 0;
    this.backoffUntil = 0;
    this.latencyMs = provider === 'scripted' ? this.options.simulatedLatencyMs : LATENCY_GUESS_MS[provider] || 300;
    this.compatLevel = 0; // 0 = full request, 1 = no response_format, 2 = also no temperature
    this.duckTimer = 0;
    this.consecutiveErrors = 0;
    this.stats = { calls: 0, ok: 0, errors: 0, latencies: [], recent: [], tokensIn: 0, tokensOut: 0, costUsd: 0, actions: { jump: 0, duck: 0, run: 0 }, stale: 0, lastLatencyMs: null };
  }

  start() {
    this.running = true;
    this.runId++;
    if (this.options.cadence === 'interval') this.intervalLoop(this.runId);
    else this.sequentialLoop(this.runId);
  }

  stop() {
    this.running = false;
    this.runId++;
    clearTimeout(this.timer);
    clearTimeout(this.duckTimer);
  }

  get isRunning() { return this.running; }

  /** One call after another: the next request leaves when the previous answer has arrived. */
  async sequentialLoop(runId) {
    while (this.running && runId === this.runId) {
      if (this.game.status !== 'running') { await sleep(60); continue; }
      const r = await this.oneCall(runId);
      if (r.cancelled) break;
      if (r.fatal) { this.running = false; break; }
      if (r.error) { await sleep(Math.min(2500, 250 * this.consecutiveErrors)); continue; }
      await nextFrame();
    }
  }

  /** A new request every intervalMs, without waiting for the previous answer (stateless calls can overlap). */
  intervalLoop(runId) {
    const tick = () => {
      if (!this.running || runId !== this.runId) return;
      if (this.game.status === 'running' && this.inFlight < MAX_IN_FLIGHT && performance.now() >= this.backoffUntil) {
        this.oneCall(runId).then((r) => {
          if (r.fatal) { this.running = false; clearTimeout(this.timer); }
          else if (r.error) this.backoffUntil = performance.now() + Math.min(2500, 250 * this.consecutiveErrors);
        });
      }
      this.timer = setTimeout(tick, Math.max(30, this.options.intervalMs));
    };
    tick();
  }

  /** Snapshot → state → request → parse → press the key. Returns { error, fatal, cancelled }. */
  async oneCall(runId) {
    this.inFlight++;
    try {
      const snapshot = this.game.snapshot();
      const state = buildState(snapshot, { latencyMs: this.latencyMs, timingAssist: this.options.timingAssist, jumpProfile: (s) => this.game.jumpProfile(s) });
      const payload = this.provider === 'openrouter_chat'
        ? buildChatPayload(this.model, state, { ...this.options, compatLevel: this.compatLevel })
        : buildDecisionPayload(this.model, state, this.options);

      const n = ++this.stats.calls;
      const entry = this.panel ? this.panel.begin({ n, provider: this.provider, model: this.model, payload, state }) : null;
      const t0 = performance.now();
      const result = await this.call(payload, state);
      const totalMs = performance.now() - t0;
      const cancelled = runId !== this.runId;
      const stale = cancelled || this.game.status !== 'running'; // paused, crashed or a newer run: do not act on it

      let parsed = null;
      let error = result.ok ? null : (result.error || `HTTP ${result.status}`);
      if (result.ok) {
        try {
          parsed = this.provider === 'openrouter_chat' ? parseChatResponse(result.response) : parseDecisionResponse(result.response);
        } catch (err) {
          error = err.message;
        }
      } else if (this.provider === 'openrouter_chat' && result.status === 400 && this.compatLevel < 2) {
        // Some models reject structured outputs or sampling parameters: simplify the request and retry.
        this.compatLevel++;
        error = `${error} — retrying with a simpler request (${this.compatLevel === 1 ? 'without response_format' : 'without temperature'})`;
      }

      const upstreamMs = result.latency_ms != null ? result.latency_ms : totalMs;
      if (parsed) {
        this.latencyMs = this.latencyMs * 0.6 + upstreamMs * 0.4;
        this.stats.ok++;
        this.stats.latencies.push(upstreamMs);
        if (this.stats.latencies.length > 500) this.stats.latencies.shift();
        this.stats.lastLatencyMs = upstreamMs;
        this.stats.tokensIn += parsed.tokensIn || 0;
        this.stats.tokensOut += parsed.tokensOut || 0;
        this.stats.costUsd += this.estimateCost(parsed);
        this.consecutiveErrors = 0;
        if (!stale) {
          this.stats.actions[parsed.action]++;
          this.applyAction(parsed.action);
        } else {
          this.stats.stale++;
        }
      } else {
        this.stats.errors++;
        this.consecutiveErrors++;
      }
      const now = performance.now();
      this.stats.recent.push(now);
      this.stats.recent = this.stats.recent.filter((t) => now - t < 5000);

      if (this.panel && entry) {
        this.panel.complete(entry, {
          ok: Boolean(parsed), error, stale, result, parsed,
          totalMs: Math.round(totalMs), upstreamMs: Math.round(upstreamMs),
          stateAgeMs: Math.round(this.game.runningTime - snapshot.timeMs),
        });
        this.panel.updateStats(this.statsSummary());
      }
      if (this.hooks.onDecision) {
        this.hooks.onDecision({ parsed, error, stale, state, totalMs, upstreamMs, stats: this.statsSummary() });
      }

      const fatal = Boolean(error) && (result.status === 401 || result.status === 403 || (result.status === 404 && this.provider !== 'openrouter_chat') || this.consecutiveErrors >= 12);
      if (error && !cancelled && this.hooks.onError) this.hooks.onError(error, fatal);
      return { error, fatal, cancelled };
    } finally {
      this.inFlight--;
    }
  }

  async call(payload, state) {
    if (this.provider === 'scripted') {
      const t0 = performance.now();
      await sleep(this.options.simulatedLatencyMs);
      const verdict = scriptedDecide(state);
      const probabilities = fakeDistribution(verdict.action, 0.9);
      const response = {
        _note: 'Scripted rule of thumb running in the browser. Not a model.',
        model: 'scripted-bot',
        answers: {
          action: { type: 'choice', choice: verdict.action, confidence: probabilities[verdict.action], probabilities },
          ...(this.options.dangerQuestion ? { danger: { type: 'score', score: verdict.danger, confidence: 1, probabilities: { [verdict.danger]: 1 } } } : {}),
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      return { ok: true, status: 200, latency_ms: Math.round(performance.now() - t0), url: '(in-browser)', response };
    }
    try {
      const res = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this.provider, payload }),
      });
      const json = await res.json();
      if (!res.ok && json && json.ok === undefined) return { ok: false, status: res.status, error: json.error || `Server error ${res.status}` };
      return json;
    } catch (err) {
      return { ok: false, status: 0, error: `Could not reach the local server: ${err.message}` };
    }
  }

  applyAction(action) {
    const game = this.game;
    clearTimeout(this.duckTimer);
    if (action === 'jump') {
      game.setDuck(false);
      game.jump();
    } else if (action === 'duck') {
      game.setDuck(true); // on the ground: crouch; in the air: drop faster and crouch on landing
      // Safety: if no newer decision arrives, stand back up.
      this.duckTimer = setTimeout(() => game.setDuck(false), Math.max(900, this.latencyMs * 2.5));
    } else {
      game.setDuck(false);
    }
  }

  estimateCost(parsed) {
    const p = this.options.pricing || {};
    if (this.provider === 'openrouter_chat') {
      return (parsed.tokensIn || 0) * (p.promptUsdPerToken || 0) + (parsed.tokensOut || 0) * (p.completionUsdPerToken || 0);
    }
    if (this.provider === 'scripted') return 0;
    const perMillion = p.jevUsdPerMillionInputTokens != null ? p.jevUsdPerMillionInputTokens : 0.042;
    return (parsed.tokensIn || 0) * perMillion / 1e6;
  }

  statsSummary() {
    const l = this.stats.latencies;
    const sorted = [...l].sort((a, b) => a - b);
    const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
    return {
      calls: this.stats.calls,
      ok: this.stats.ok,
      errors: this.stats.errors,
      stale: this.stats.stale,
      inFlight: this.inFlight,
      lastLatencyMs: this.stats.lastLatencyMs,
      avgLatencyMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null,
      p50LatencyMs: pct(0.5),
      maxLatencyMs: sorted.length ? sorted[sorted.length - 1] : null,
      minLatencyMs: sorted.length ? sorted[0] : null,
      callsPerSecond: Math.round((this.stats.recent.length / 5) * 10) / 10,
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      costUsd: this.stats.costUsd,
      actions: { ...this.stats.actions },
    };
  }
}
