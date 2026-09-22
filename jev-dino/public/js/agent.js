// ============================================================================
//  The agent: turns a game snapshot into model input, calls the chosen model
//  through the local server, parses the typed answer and tells the game what
//  to do about the nearest obstacle.
//
//  Division of labour (execution = "scheduled", the default):
//    * the model decides WHAT to do about an obstacle: jump / duck / run;
//    * the engine decides WHEN: it presses jump at the first safe frame for
//      that obstacle (after landing if airborne) and holds duck until the
//      obstacle has passed. One correct answer per obstacle is enough, as
//      long as it arrives before the jump window closes.
//  execution = "reflex" is the naive variant: the key is pressed the instant
//  the answer lands, so timing precision depends on the model's latency.
//
//  Every call is stateless. Nothing is remembered between calls: the full
//  situation and the rules travel with each request.
// ============================================================================

import { TREX } from './sprites.js';
import { FRAME_MS, describeType } from './game.js';

export const ACTIONS = ['jump', 'duck', 'run'];

const LATENCY_GUESS_MS = { typesafe: 350, openrouter_decisions: 450, openrouter_chat: 1500, scripted: 150, laya: 200 };
// Jev's API queued up beyond two concurrent calls per key in testing; LLM gateways tolerate more, and slow
// answers need more overlap to keep decisions flowing.
const MAX_IN_FLIGHT = { typesafe: 2, openrouter_decisions: 2, openrouter_chat: 4, scripted: 4, laya: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------ the state ----

/**
 * Build the model-facing state from a game snapshot.
 * Physics facts (distances, times, jump windows) are computed here in code; the model only
 * makes the judgment call. `latencyMs` is the model's recent latency, used to express times
 * "when your answer lands". `jumpWindow(o, startX, relSpeed)` is game.safeJumpDelays.
 */
export function buildState(snapshot, { latencyMs, execution = 'scheduled', timingAssist = true, jumpProfile, jumpWindow }) {
  const { trex, speed } = snapshot;
  const profile = jumpProfile(speed);
  const scheduled = execution !== 'reflex';
  const dinoState = trex.jumping ? 'jumping' : trex.ducking ? 'ducking' : 'running';
  const latencyFrames = latencyMs / FRAME_MS;

  const describe = (o, detailed) => {
    const relSpeed = speed + (o.speedOffset || 0); // px per frame towards the dino
    const distancePx = o.x - (trex.x + TREX.width);
    const arrivesMs = (distancePx / relSpeed) * FRAME_MS;
    const out = { id: o.id };
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
    const xAtArrival = o.x - relSpeed * latencyFrames;
    const w = jumpWindow(o, xAtArrival, relSpeed);
    const c = arrivesMs - latencyMs;
    let window = null;
    if (w.firstSafeDelay != null) {
      window = { start_ms: r0(c - w.firstSafeDelay * FRAME_MS), end_ms: r0(c - w.lastSafeDelay * FRAME_MS) };
    }
    if (scheduled) {
      if (!w.runsUnder) {
        out.jump_still_possible_after_answer = !w.alreadyPassed && w.lastSafeDelay != null;
        out.time_to_spare_ms = w.lastSafeDelay != null ? r0(w.lastSafeDelay * FRAME_MS) : r0(Math.min(c, 0));
      }
    } else if (timingAssist) {
      if (trex.jumping) out.jump_timing = 'airborne (already in a jump)';
      else if (distancePx < 0) out.jump_timing = o.type === 'pterodactyl' && o.y === 75 ? 'passing_overhead (it is above the dino right now)' : 'passing (the obstacle is beside the dino)';
      else if (w.runsUnder) out.jump_timing = 'not_needed (it passes above a running dino)';
      else if (w.alreadyPassed) out.jump_timing = 'too_late (it reaches the dino before your answer lands)';
      else if (w.firstSafeDelay === 0) out.jump_timing = 'now';
      else if (w.firstSafeDelay != null) out.jump_timing = 'too_early';
      else out.jump_timing = 'too_late';
    }
    out._window = window; // stripped before sending; used by the timing block below
    return out;
  };

  // While airborne, an obstacle the current jump already clears needs no decision: skip to the next one.
  const pending = snapshot.obstacles.filter((o) => !o.clearing);
  const cleared = snapshot.obstacles.find((o) => o.clearing);
  const [first, second] = pending;
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
  if (cleared) state.dino.currently_jumping_over = describeType(cleared);
  if (!scheduled && !timingAssist && window) state.timing.jump_window_ms = window;
  return state;
}

/**
 * A shorter version of the same state for small-context models (Laya's English checkpoint keeps
 * about 320 tokens of state and 192 tokens of question header). Same facts, shorter words.
 */
export function compactState(state) {
  const short = (o) => (o ? {
    id: o.id,
    kind: o.kind === 'pterodactyl' ? `pterodactyl flying ${o.flying_height.split(' ')[0]}` : `${o.count > 1 ? o.count + 'x ' : ''}${o.size} cactus`,
    height_px: o.height_px,
    distance_px: o.distance_px,
    arrives_in_ms: o.arrives_in_ms,
    ...(o.arrives_in_ms_when_answer_lands != null ? { arrives_in_ms_after_your_answer: o.arrives_in_ms_when_answer_lands } : {}),
    ...(o.jump_timing ? { jump_timing: o.jump_timing.split(' ')[0] } : {}),
  } : null);
  return {
    dino: state.dino.state + (state.dino.currently_jumping_over ? ` (clearing a ${state.dino.currently_jumping_over})` : ''),
    speed_px_per_s: state.speed_px_per_s,
    nearest_obstacle: short(state.nearest_obstacle),
    next_obstacle: short(state.next_obstacle),
    your_latency_ms: state.timing.your_recent_latency_ms,
  };
}

/** The same facts as prose, for the "plain text" state format. */
export function toProse(state) {
  const parts = [];
  parts.push(`Frame ${state.frame}, score ${state.score}. The dino is ${state.dino.state} at ${state.speed_px_per_s} px/s (${state.speed_px_per_frame} px per frame)` +
    (state.dino.state === 'jumping' ? `, ${state.dino.height_above_ground_px} px above the ground, landing in ${state.dino.lands_in_ms} ms` : '') +
    (state.dino.currently_jumping_over ? `, clearing a ${state.dino.currently_jumping_over}` : '') +
    `. Standing it is ${state.dino.standing_height_px} px tall, ducking ${state.dino.ducking_height_px} px.`);
  const what = (o) => (o.kind === 'pterodactyl' ? `a pterodactyl flying ${o.flying_height}` : o.count > 1 ? `a group of ${o.count} ${o.size} cacti` : `a ${o.size} cactus`);
  const o = state.nearest_obstacle;
  if (!o) parts.push('There is no obstacle to decide about.');
  else {
    parts.push(`Nearest obstacle (#${o.id}): ${what(o)}, ${o.width_px} px wide and ${o.height_px} px tall, ${o.distance_px} px ahead; it arrives in ${o.arrives_in_ms} ms, i.e. about ${o.arrives_in_ms_when_answer_lands} ms after your answer lands.` +
      (o.jump_timing ? ` Jump timing: ${o.jump_timing}.` : '') +
      (o.time_to_spare_ms != null ? (o.jump_still_possible_after_answer ? ` After your answer lands there are ${o.time_to_spare_ms} ms to spare before the last moment a jump can start.` : ' By the time your answer lands, a jump can no longer clear it.') : ''));
  }
  const n = state.next_obstacle;
  if (n) parts.push(`Behind it (#${n.id}): ${what(n)}, ${n.distance_px} px ahead, arriving in ${n.arrives_in_ms} ms.`);
  const t = state.timing;
  parts.push(`Your recent latency is ${t.your_recent_latency_ms} ms. A jump lasts ${t.jump_airtime_ms} ms and reaches ${t.jump_apex_px} px.` +
    (t.jump_window_ms ? ` A jump clears the nearest obstacle only if started when it is between ${t.jump_window_ms.start_ms} and ${t.jump_window_ms.end_ms} ms away (after your latency).` : ''));
  return parts.join(' ');
}

// -------------------------------------------------------- the questions ----

function rulesText(opts) {
  const scheduled = opts.execution !== 'reflex';
  if (opts.compact) {
    return scheduled
      ? 'Chrome dino game. The game times the key press; you decide per obstacle. Cactus or low pterodactyl: jump. Mid-height pterodactyl: duck. High pterodactyl: run.'
      : 'Chrome dino game; the key is pressed when your answer lands. jump_timing now: jump. too_early: run. too_late: jump anyway. Mid pterodactyl close: duck. High pterodactyl: run.';
  }
  if (scheduled) {
    return [
      'You decide what the T-Rex in the Chrome dinosaur game should do about the nearest obstacle; the game handles the exact timing.',
      'When you answer jump, the game presses jump at the right moment for that obstacle even if you answer early (if the dino is in the air, right after it lands). When you answer duck, it crouches shortly before the obstacle and stays down until it has passed. Answer as early as you can: your answers take about your_recent_latency_ms to arrive.',
      'Cacti and a pterodactyl flying low must be jumped over. A pterodactyl at mid height must be ducked under. A pterodactyl flying high needs nothing: answer run. Never duck for a cactus and never jump for a mid or high pterodactyl.',
    ].join(' ');
  }
  return [
    'You are the reflexes of the T-Rex in the Chrome dinosaur game. The game presses the key you choose the instant your answer arrives, then asks again.',
    opts.timingAssist
      ? 'jump_timing says whether a jump started when your answer lands clears the nearest obstacle: "now" means jump this instant; "too_early" means keep running and wait; "too_late" means jump anyway, it is the last chance; "not_needed" means it passes above a running dino; "airborne" or "passing" means no jump is possible.'
      : 'A jump lasts jump_airtime_ms and cannot be cancelled, so a jump started too early lands on the obstacle. Jump only when arrives_in_ms_when_answer_lands is inside jump_window_ms (between its start_ms and end_ms).',
    'Cacti and a pterodactyl flying low must be jumped over. A pterodactyl at mid height must be ducked under: choose duck when it is close (within about 700 ms), even while still in the air from a previous jump, and stay ducked while it is passing overhead. A pterodactyl flying high is harmless: keep running. Never duck for a cactus.',
  ].join(' ');
}

export function buildQuestions(opts, state = null) {
  const scheduled = opts.execution !== 'reflex';
  if (opts.compact) {
    const questions = {
      action: {
        type: 'choice',
        instructions: `${rulesText(opts)} What about nearest_obstacle?`,
        criteria: { jump: 'jump over it', duck: 'crouch under it', run: 'do nothing' },
      },
    };
    if (scheduled && state && state.next_obstacle) {
      questions.next_obstacle_action = { type: 'choice', instructions: 'And next_obstacle?', criteria: { jump: 'jump over it', duck: 'crouch under it', run: 'do nothing' } };
    }
    if (opts.dangerQuestion) {
      questions.danger = { type: 'score', instructions: 'How dangerous is the situation for the dino?', criteria: ['safe', 'caution', 'urgent', 'critical'] };
    }
    return questions;
  }
  const questions = {
    action: {
      type: 'choice',
      instructions: `${rulesText(opts)} ${scheduled ? 'What should the dino do about the nearest obstacle (nearest_obstacle)?' : 'Which input should the game press right now?'}`,
      criteria: scheduled
        ? {
            jump: 'Jump over this obstacle (the game times the jump).',
            duck: 'Crouch under this obstacle until it has passed.',
            run: 'Do nothing about this obstacle: keep running.',
          }
        : {
            jump: 'Press the jump key now.',
            duck: 'Hold the duck key now (crouch under a pterodactyl at mid height).',
            run: 'Press nothing: keep running.',
          },
    },
  };
  if (scheduled && state && state.next_obstacle) {
    questions.next_obstacle_action = {
      type: 'choice',
      instructions: 'And what should the dino do about the obstacle after that (next_obstacle)? The game will time it as well; answering now buys time when obstacles come close together.',
      criteria: {
        jump: 'Jump over the next obstacle when it comes.',
        duck: 'Crouch under the next obstacle when it comes.',
        run: 'Do nothing about the next obstacle.',
      },
    };
  }
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
  const sent = opts.compact ? compactState(state) : state;
  return {
    model,
    state: opts.stateFormat === 'text' ? (opts.compact ? compactProse(sent) : toProse(state)) : sent,
    questions: buildQuestions(opts, state),
  };
}

function compactProse(c) {
  const o = (x) => (x ? `${x.kind}, ${x.height_px} px tall, ${x.distance_px} px ahead, arrives in ${x.arrives_in_ms} ms${x.arrives_in_ms_after_your_answer != null ? ` (${x.arrives_in_ms_after_your_answer} ms after your answer)` : ''}${x.jump_timing ? `, jump timing ${x.jump_timing}` : ''}` : 'none');
  return `Dino ${c.dino} at ${c.speed_px_per_s} px/s. Nearest obstacle: ${o(c.nearest_obstacle)}. Next obstacle: ${o(c.next_obstacle)}. Your latency ${c.your_latency_ms} ms.`;
}

export function buildChatPayload(model, state, opts) {
  const scheduled = opts.execution !== 'reflex';
  const system = scheduled
    ? `${rulesText(opts)} Respond with a single JSON object and nothing else: {"action": "jump" | "duck" | "run" (what to do about nearest_obstacle), "next_action": "jump" | "duck" | "run" (what to do about next_obstacle; "run" if there is none), "danger": 0-3 (0 safe, 1 caution, 2 urgent, 3 critical), "reason": "at most ten words"}.`
    : `${rulesText(opts)} Respond with a single JSON object and nothing else: {"action": "jump" | "duck" | "run", "danger": 0-3 (0 safe, 1 caution, 2 urgent, 3 critical), "reason": "at most ten words"}.`;
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
          properties: scheduled
            ? { action: { type: 'string', enum: ACTIONS }, next_action: { type: 'string', enum: ACTIONS }, danger: { type: 'integer', minimum: 0, maximum: 3 }, reason: { type: 'string' } }
            : { action: { type: 'string', enum: ACTIONS }, danger: { type: 'integer', minimum: 0, maximum: 3 }, reason: { type: 'string' } },
          required: scheduled ? ['action', 'next_action', 'danger', 'reason'] : ['action', 'danger', 'reason'],
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
  if (!a || (a.type && a.type !== 'choice') || !ACTIONS.includes(a.choice)) {
    throw new Error(`Unexpected answer shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const d = json.answers.danger;
  const nx = json.answers.next_obstacle_action;
  const isChoice = (x) => x && (x.type ? x.type === 'choice' : typeof x.choice === 'string');
  const isScore = (x) => x && (x.type ? x.type === 'score' : typeof x.score === 'number');
  return {
    action: a.choice,
    confidence: a.confidence,
    probabilities: a.probabilities,
    nextAction: isChoice(nx) && ACTIONS.includes(nx.choice) ? nx.choice : null,
    nextProbabilities: isChoice(nx) ? nx.probabilities : null,
    danger: isScore(d) ? { score: d.score, confidence: d.confidence, probabilities: d.probabilities, legend: d.legend } : null,
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
  const nextAction = String(parsed.next_action || '').trim().toLowerCase();
  return {
    action,
    confidence: null,
    probabilities,
    nextAction: ACTIONS.includes(nextAction) ? nextAction : null,
    nextProbabilities: null,
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
const byKind = (o) => {
  if (!o) return 'run';
  const band = o.kind === 'pterodactyl' ? o.flying_height.split(' ')[0] : null;
  return band === 'high' ? 'run' : band === 'mid' ? 'duck' : 'jump';
};

export function scriptedDecide(state, execution = 'scheduled') {
  const o = state.nearest_obstacle;
  if (!o) return { action: 'run', nextAction: 'run', danger: 0 };
  const band = o.kind === 'pterodactyl' ? o.flying_height.split(' ')[0] : null;
  const nextAction = byKind(state.next_obstacle);
  if (band === 'high') return { action: 'run', nextAction, danger: 1 };
  if (execution !== 'reflex') {
    if (band === 'mid') return { action: 'duck', nextAction, danger: o.arrives_in_ms_when_answer_lands < 800 ? 2 : 1 };
    return { action: 'jump', nextAction, danger: o.arrives_in_ms_when_answer_lands < 600 ? 2 : 1 };
  }
  // reflex mode: timing matters
  if (band === 'mid') {
    const soon = o.arrives_in_ms_when_answer_lands < 700;
    return { action: soon ? 'duck' : 'run', danger: soon ? 2 : 1 };
  }
  if (state.dino.state === 'jumping') return { action: 'run', danger: 1 };
  let timing = o.jump_timing ? o.jump_timing.split(' ')[0] : null;
  if (!timing) {
    const w = state.timing.jump_window_ms;
    const c = o.arrives_in_ms_when_answer_lands;
    timing = !w ? 'too_late' : c > w.start_ms ? 'too_early' : c >= w.end_ms ? 'now' : 'too_late';
  }
  if (timing === 'now') return { action: 'jump', danger: 2 };
  if (timing === 'too_late') return { action: 'jump', danger: 3 };
  if (timing === 'not_needed') return { action: 'run', danger: 1 };
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

export class Agent {
  /**
   * @param {object} p
   * @param {'typesafe'|'openrouter_decisions'|'openrouter_chat'|'scripted'} p.provider
   * @param {string} p.model
   * @param {import('./game.js').DinoGame} p.game
   * @param {object} p.panel   IOPanel
   * @param {object} p.options { execution, stateFormat, timingAssist, dangerQuestion, cadence, intervalMs, simulatedLatencyMs, initialLatencyMs, pricing }
   * @param {object} p.hooks   { onDecision(info), onError(message, fatal) }
   */
  constructor({ provider, model, game, panel, options = {}, hooks = {} }) {
    this.provider = provider;
    this.model = model;
    this.game = game;
    this.panel = panel;
    this.options = { execution: 'scheduled', stateFormat: 'json', timingAssist: true, dangerQuestion: true, cadence: 'interval', intervalMs: 300, simulatedLatencyMs: 150, initialLatencyMs: null, pricing: {}, ...options };
    if (this.options.compact == null) this.options.compact = provider === 'laya'; // small context: shorter prompt
    this.hooks = hooks;
    this.running = false;
    this.runId = 0;
    this.timer = 0;
    this.inFlight = 0;
    this.backoffUntil = 0;
    this.latencyMs = provider === 'scripted'
      ? this.options.simulatedLatencyMs
      : (this.options.initialLatencyMs || LATENCY_GUESS_MS[provider] || 300);
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

  /** A new request every intervalMs (at most MAX_IN_FLIGHT at once); stateless calls can overlap. */
  intervalLoop(runId) {
    const tick = () => {
      if (!this.running || runId !== this.runId) return;
      const cap = MAX_IN_FLIGHT[this.provider] || 2;
      if (this.game.status === 'running' && this.inFlight < cap && performance.now() >= this.backoffUntil) {
        this.oneCall(runId).then((r) => {
          if (r.fatal) { this.running = false; clearTimeout(this.timer); }
          else if (r.error) this.backoffUntil = performance.now() + Math.min(2500, 250 * this.consecutiveErrors);
        });
      }
      this.timer = setTimeout(tick, Math.max(30, this.options.intervalMs));
    };
    tick();
  }

  /** Snapshot → state → request → parse → act. Returns { error, fatal, cancelled }. */
  async oneCall(runId) {
    this.inFlight++;
    try {
      const snapshot = this.game.snapshot();
      const state = buildState(snapshot, {
        latencyMs: this.latencyMs,
        execution: this.options.execution,
        timingAssist: this.options.timingAssist,
        jumpProfile: (s) => this.game.jumpProfile(s),
        jumpWindow: (o, startX, relSpeed) => this.game.safeJumpDelays(o, startX, relSpeed),
      });
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
      let applied = null;
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
          applied = this.applyAction(parsed.action, state, n, parsed.nextAction);
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
          ok: Boolean(parsed), error, stale, result, parsed, applied,
          totalMs: Math.round(totalMs), upstreamMs: Math.round(upstreamMs),
          stateAgeMs: Math.round(this.game.runningTime - snapshot.timeMs),
        });
        this.panel.updateStats(this.statsSummary());
      }
      if (this.hooks.onDecision) {
        this.hooks.onDecision({ parsed, error, stale, applied, state, totalMs, upstreamMs, stats: this.statsSummary() });
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
      const verdict = scriptedDecide(state, this.options.execution);
      const probabilities = fakeDistribution(verdict.action, 0.9);
      const response = {
        _note: 'Scripted rule of thumb running in the browser. Not a model.',
        model: 'scripted-bot',
        answers: {
          action: { type: 'choice', choice: verdict.action, confidence: probabilities[verdict.action], probabilities },
          ...(state.next_obstacle && this.options.execution !== 'reflex' ? { next_obstacle_action: { type: 'choice', choice: verdict.nextAction, confidence: 0.9, probabilities: fakeDistribution(verdict.nextAction, 0.9) } } : {}),
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

  /**
   * Scheduled execution: hand the decision to the engine as a plan for the obstacle the state was about.
   * Reflex execution: press the key right now. Returns a short description of what was done.
   */
  applyAction(action, state, seq, parsedNext = null) {
    const game = this.game;
    if (this.options.execution !== 'reflex') {
      const target = state.nearest_obstacle;
      if (!target) return 'nothing to plan';
      const notes = [];
      const accepted = game.setIntent(target.id, action, seq);
      if (!accepted) notes.push(`#${target.id}: ignored (a newer answer already covers it)`);
      else notes.push(action === 'run' ? `#${target.id}: nothing planned` : `#${target.id}: ${action} planned`);
      const next = state.next_obstacle;
      if (next && parsedNext) {
        const ok2 = game.setIntent(next.id, parsedNext, seq);
        if (ok2) notes.push(parsedNext === 'run' ? `#${next.id}: nothing planned` : `#${next.id}: ${parsedNext} planned`);
      }
      return `${notes.join(', ')} — the game presses at the right frame`;
    }
    clearTimeout(this.duckTimer);
    if (action === 'jump') {
      game.setDuck(false);
      return game.jump() ? 'jump pressed' : 'jump ignored (already in the air)';
    }
    if (action === 'duck') {
      game.setDuck(true); // on the ground: crouch; in the air: drop faster and crouch on landing
      this.duckTimer = setTimeout(() => game.setDuck(false), Math.max(900, this.latencyMs * 2.5));
      return 'duck held';
    }
    game.setDuck(false);
    return 'nothing pressed';
  }

  estimateCost(parsed) {
    const p = this.options.pricing || {};
    if (this.provider === 'openrouter_chat') {
      return (parsed.tokensIn || 0) * (p.promptUsdPerToken || 0) + (parsed.tokensOut || 0) * (p.completionUsdPerToken || 0);
    }
    if (this.provider === 'scripted' || this.provider === 'laya') return 0; // local: no per-call cost
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
