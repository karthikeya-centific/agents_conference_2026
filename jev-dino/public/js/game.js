// ============================================================================
//  Chrome T-Rex runner engine (canvas), following Chromium's physics, sprites
//  and collision boxes, plus two additions for the demo:
//    snapshot()      -> the world state the agent turns into model input
//    jumpProfile()   -> when a jump started now would clear a given height
// ============================================================================

import { CANVAS, TREX, OBSTACLES, CLOUD, HORIZON, TEXT, GAME_OVER, RESTART, RUNNER } from './sprites.js';

export const FRAME_MS = 1000 / RUNNER.fps;
export const GROUND_LINE_Y = CANVAS.height - CANVAS.bottomPad; // 140: feet and cactus bases sit here

const OBSTACLE_TYPES = Object.keys(OBSTACLES);
const JITTER_FRAMES = 1.5;      // a jump only counts as safe if it also survives the obstacle shifted by ±this
const MAX_DELAY_FRAMES = 90;    // how far ahead (in frames) the jump window is searched
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Chromium's two-stage collision test: outer boxes first, then the inner boxes.
 * `trexBoxes` is TREX.collisionBoxes.running or .ducking; `o` needs x, y, width, height, boxes.
 * Returns the colliding pair or null.
 */
export function trexHitsObstacle(trexX, trexY, trexBoxes, o, ox = o.x) {
  const trexBox = { x: trexX + 1, y: trexY + 1, w: TREX.width - 2, h: TREX.height - 2 };
  const oBox = { x: ox + 1, y: o.y + 1, w: o.width - 2, h: o.height - 2 };
  if (!intersects(trexBox, oBox)) return null;
  for (const tb of trexBoxes) {
    for (const ob of o.boxes) {
      const a = { x: trexBox.x + tb.x, y: trexBox.y + tb.y, w: tb.w, h: tb.h };
      const b = { x: oBox.x + ob.x, y: oBox.y + ob.y, w: ob.w, h: ob.h };
      if (intersects(a, b)) return { trexBox: a, obstacleBox: b };
    }
  }
  return null;
}

export class DinoGame {
  constructor(canvas, sprite, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.sprite = sprite;
    this.callbacks = callbacks;
    this.groundY = CANVAS.height - TREX.height - CANVAS.bottomPad; // 93: top of a standing trex
    this.config = { speed: RUNNER.defaultSpeed, accelerate: true, maxSpeed: RUNNER.maxSpeed, showHitboxes: false };
    this.highScore = 0;
    this.profileCache = new Map();
    this.obstacleSeq = 0;
    this.idleTime = 0;
    this.lastTime = performance.now();
    this.raf = 0;
    this.reset();
    this.scheduleFrame();
  }

  // ------------------------------------------------------------ lifecycle --

  configure(partial) {
    Object.assign(this.config, partial);
    if (this.status === 'idle') this.speed = this.config.speed;
  }

  reset() {
    this.speed = this.config.speed;
    this.distanceRan = 0;
    this.runningTime = 0;
    this.frameCount = 0;
    this.obstacles = [];
    this.obstacleHistory = [];
    this.clouds = [];
    this.horizon = [
      { x: 0, src: HORIZON.sx + 600 },
      { x: 600, src: HORIZON.sx },
    ];
    this.trex = {
      x: TREX.startX, y: this.groundY, vy: 0,
      jumping: false, ducking: false, speedDrop: false, reachedMinHeight: false, duckOnLanding: false,
      status: 'waiting', frame: 0, frameTimer: 0,
    };
    this.stats = { jumps: 0, ducks: 0 };
    this.crashInfo = null;
    this.intents = new Map();        // obstacle id -> { action: 'jump' | 'duck', seq }
    this.intentDuckActive = false;
    this.status = 'idle';
  }

  start() {
    this.reset();
    this.status = 'running';
    this.setTrexStatus('running');
    this.lastTime = performance.now();
    if (this.callbacks.onStart) this.callbacks.onStart();
  }

  pause() { if (this.status === 'running') this.status = 'paused'; }
  resume() {
    if (this.status === 'paused') {
      this.status = 'running';
      this.lastTime = performance.now();
    }
  }
  destroy() { cancelAnimationFrame(this.raf); }

  scheduleFrame() {
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;
    if (this.status === 'running') this.update(dt);
    else this.idleTime += dt;
    this.render();
    this.scheduleFrame();
  }

  // -------------------------------------------------------------- inputs --

  /** Start a full jump. Returns false when a jump is not possible right now. */
  jump() {
    const t = this.trex;
    if (this.status !== 'running' || t.jumping) return false;
    if (t.ducking) this.setDuck(false);
    this.setTrexStatus('jumping');
    t.vy = TREX.initialJumpVelocity - this.speed / 10;
    t.jumping = true;
    t.reachedMinHeight = false;
    t.speedDrop = false;
    this.stats.jumps++;
    return true;
  }

  /** Human control: releasing the key early makes the jump shorter. */
  endJump() {
    const t = this.trex;
    if (t.jumping && t.reachedMinHeight && t.vy < TREX.dropVelocity) t.vy = TREX.dropVelocity;
  }

  /** Crouch (on the ground) or speed-drop (in the air, like holding ↓ in Chrome). */
  setDuck(on) {
    const t = this.trex;
    if (this.status !== 'running') return;
    if (on) {
      if (t.jumping) {
        // Like holding ↓ in Chrome: drop faster and stay crouched once on the ground.
        if (!t.speedDrop) { t.speedDrop = true; t.vy = 1; }
        t.duckOnLanding = true;
        return;
      }
      if (!t.ducking) { t.ducking = true; this.setTrexStatus('ducking'); this.stats.ducks++; }
    } else {
      t.duckOnLanding = false;
      if (t.ducking) {
        t.ducking = false;
        if (!t.jumping) this.setTrexStatus('running');
      }
    }
  }

  // -------------------------------------------------------------- update --

  update(dt) {
    const frames = dt / FRAME_MS;
    this.runningTime += dt;
    this.frameCount++;
    const hasObstacles = this.runningTime > RUNNER.clearTimeMs;

    this.updateHorizon(frames);
    this.updateClouds(frames);
    if (hasObstacles) this.executeIntents();
    if (hasObstacles) this.updateObstacles(dt, frames);
    this.updateTrex(dt, frames);

    const hit = hasObstacles ? this.checkCollision() : null;
    if (hit) { this.crash(hit); return; }

    this.distanceRan += this.speed * frames;
    if (this.config.accelerate && this.speed < this.config.maxSpeed) {
      this.speed = Math.min(this.config.maxSpeed, this.speed + RUNNER.acceleration * frames);
    }
  }

  updateHorizon(frames) {
    const [a, b] = this.horizon;
    a.x -= this.speed * frames;
    b.x -= this.speed * frames;
    for (const seg of this.horizon) {
      if (seg.x <= -600) {
        const other = seg === a ? b : a;
        seg.x = other.x + 600;
        seg.src = Math.random() > 0.5 ? HORIZON.sx : HORIZON.sx + 600;
      }
    }
  }

  updateClouds(frames) {
    const step = this.speed * CLOUD.speed * frames;
    for (const c of this.clouds) c.x -= step;
    this.clouds = this.clouds.filter((c) => c.x + CLOUD.width > 0);
    const last = this.clouds[this.clouds.length - 1];
    if (!last || (this.clouds.length < CLOUD.maxClouds && CANVAS.width - last.x > last.gap && Math.random() < CLOUD.frequency)) {
      this.clouds.push({ x: CANVAS.width, y: randInt(CLOUD.minSky, CLOUD.maxSky), gap: randInt(CLOUD.minGap, CLOUD.maxGap) });
    }
  }

  updateObstacles(dt, frames) {
    for (const o of this.obstacles) {
      o.x -= (this.speed + o.speedOffset) * frames;
      if (o.numFrames) {
        o.frameTimer += dt;
        if (o.frameTimer >= o.frameRate) { o.frame = (o.frame + 1) % o.numFrames; o.frameTimer = 0; }
      }
    }
    this.obstacles = this.obstacles.filter((o) => o.x + o.width > 0);
    const last = this.obstacles[this.obstacles.length - 1];
    if (!last) this.addObstacle();
    else if (!last.followingCreated && last.x + last.width + last.gap < CANVAS.width) {
      this.addObstacle();
      last.followingCreated = true;
    }
  }

  isDuplicate(type) {
    return this.obstacleHistory.length >= RUNNER.maxObstacleDuplication && this.obstacleHistory.every((t) => t === type);
  }

  addObstacle() {
    let type;
    let attempts = 0;
    do {
      type = OBSTACLE_TYPES[randInt(0, OBSTACLE_TYPES.length - 1)];
      attempts++;
    } while (attempts < 12 && (this.isDuplicate(type) || this.speed < OBSTACLES[type].minSpeed));

    const def = OBSTACLES[type];
    let size = randInt(1, RUNNER.maxObstacleLength);
    if (size > 1 && def.multipleSpeed > this.speed) size = 1;
    const width = def.width * size;
    const y = Array.isArray(def.yPos) ? def.yPos[randInt(0, def.yPos.length - 1)] : def.yPos;
    const speedOffset = def.speedOffset ? (Math.random() > 0.5 ? def.speedOffset : -def.speedOffset) : 0;
    const minGap = Math.round(width * this.speed + def.minGap * RUNNER.gapCoefficient);
    const gap = randInt(minGap, Math.round(minGap * RUNNER.maxGapCoefficient));
    const boxes = def.collisionBoxes.map((b) => ({ ...b }));
    if (size > 1) {
      boxes[1].w = width - boxes[0].w - boxes[2].w;
      boxes[2].x = width - boxes[2].w;
    }
    this.obstacles.push({
      id: ++this.obstacleSeq, type, size, x: CANVAS.width, y, width, height: def.height,
      speedOffset, gap, followingCreated: false, boxes,
      frame: 0, frameTimer: 0, numFrames: def.numFrames || 0, frameRate: def.frameRate || 0,
    });
    this.obstacleHistory.unshift(type);
    this.obstacleHistory.splice(RUNNER.maxObstacleDuplication);
  }

  setTrexStatus(status) {
    const t = this.trex;
    if (t.status !== status) { t.status = status; t.frame = 0; t.frameTimer = 0; }
  }

  updateTrex(dt, frames) {
    const t = this.trex;
    t.frameTimer += dt;
    const seq = TREX.frames[t.status];
    if (t.frameTimer >= TREX.msPerFrame[t.status]) { t.frame = (t.frame + 1) % seq.length; t.frameTimer = 0; }
    if (t.jumping) this.updateJump(frames);
  }

  updateJump(frames) {
    const t = this.trex;
    t.y += t.speedDrop ? t.vy * TREX.speedDropCoefficient * frames : t.vy * frames;
    t.vy += TREX.gravity * frames;
    if (t.y < this.groundY - TREX.minJumpHeight || t.speedDrop) t.reachedMinHeight = true;
    if (t.y < TREX.maxJumpHeight || t.speedDrop) this.endJump();
    if (t.y >= this.groundY) {
      t.y = this.groundY;
      t.jumping = false;
      t.vy = 0;
      t.speedDrop = false;
      if (t.duckOnLanding && !t.ducking) { t.ducking = true; this.stats.ducks++; }
      t.duckOnLanding = false;
      this.setTrexStatus(t.ducking ? 'ducking' : 'running');
    }
  }

  checkCollision() {
    const t = this.trex;
    const tBoxes = t.ducking ? TREX.collisionBoxes.ducking : TREX.collisionBoxes.running;
    for (const o of this.obstacles) {
      const hit = trexHitsObstacle(t.x, t.y, tBoxes, o);
      if (hit) return { obstacle: o, ...hit };
    }
    return null;
  }

  crash(hit) {
    this.status = 'crashed';
    this.setTrexStatus('crashed');
    this.crashInfo = { obstacle: describeType(hit.obstacle), score: this.score() };
    this.highScore = Math.max(this.highScore, this.score());
    if (this.callbacks.onCrash) this.callbacks.onCrash(this.summary());
  }

  score() { return Math.round(this.distanceRan * RUNNER.scoreCoefficient); }

  summary() {
    return {
      score: this.score(),
      highScore: this.highScore,
      speed: this.speed,
      distancePx: Math.round(this.distanceRan),
      runningTimeMs: Math.round(this.runningTime),
      jumps: this.stats.jumps,
      ducks: this.stats.ducks,
      crashedInto: this.crashInfo ? this.crashInfo.obstacle : null,
    };
  }

  // ------------------------------------------------- timing & intents --

  /**
   * In which frames, counted from the moment the obstacle is at `startX`, could a full jump start and
   * get past `o`? Simulated frame by frame with the real jump curve and Chromium's collision boxes,
   * requiring survival with the obstacle shifted by ±JITTER_FRAMES as well.
   * Returns { runsUnder, alreadyPassed, firstSafeDelay, lastSafeDelay } (delays in frames, or null).
   */
  safeJumpDelays(o, startX = o.x, relSpeed = this.speed + (o.speedOffset || 0)) {
    const trexX = this.trex.x;
    const groundY = this.groundY;
    const running = TREX.collisionBoxes.running;
    const heights = this.jumpProfile(this.speed).heights;
    const survives = (x0, heightAt) => {
      for (let k = 0; k <= 600; k++) {
        const ox = x0 - relSpeed * k;
        if (ox + o.width <= trexX) return true; // obstacle has passed
        if (trexHitsObstacle(trexX, groundY - heightAt(k), running, o, ox)) return false;
      }
      return true;
    };
    const runsUnder = survives(o.x, () => 0); // a running dino gets past it (high pterodactyl), judged from now
    if (runsUnder) return { runsUnder, alreadyPassed: false, firstSafeDelay: null, lastSafeDelay: null };
    if (startX < trexX + TREX.width) return { runsUnder, alreadyPassed: true, firstSafeDelay: null, lastSafeDelay: null };
    const shift = relSpeed * JITTER_FRAMES;
    const safe = (d) => {
      const heightAt = (k) => (k < d || k - d >= heights.length ? 0 : heights[k - d]);
      return survives(startX, heightAt) && survives(startX + shift, heightAt) && survives(startX - shift, heightAt);
    };
    let first = null;
    let last = null;
    for (let d = 0; d <= MAX_DELAY_FRAMES; d++) {
      if (safe(d)) { if (first == null) first = d; last = d; }
      else if (first != null) break; // the safe window is one contiguous interval
    }
    return { runsUnder, alreadyPassed: false, firstSafeDelay: first, lastSafeDelay: last };
  }

  /**
   * Record what to do about an obstacle. The engine presses the key at the right frame:
   * 'jump' starts the jump at the first safe moment (after landing if airborne), 'duck' crouches
   * shortly before the obstacle and holds until it has passed, 'run' cancels a plan.
   * `seq` orders answers: an older answer never overrides a newer one for the same obstacle.
   */
  setIntent(obstacleId, action, seq = 0) {
    const existing = this.intents.get(obstacleId);
    if (existing && existing.seq > seq) return false;
    if (action === 'run') { this.intents.delete(obstacleId); return true; }
    if (action !== 'jump' && action !== 'duck') return false;
    this.intents.set(obstacleId, { action, seq, since: this.runningTime });
    return true;
  }

  plannedActions() {
    return Array.from(this.intents.entries()).map(([id, i]) => `${i.action} → #${id}`);
  }

  executeIntents() {
    if (this.intents.size === 0 && !this.intentDuckActive) return;
    const t = this.trex;
    let holdDuck = false;
    let jumpedThisFrame = false;
    for (const o of this.obstacles) {
      const intent = this.intents.get(o.id);
      if (!intent) continue;
      if (o.x + o.width <= t.x) { this.intents.delete(o.id); continue; } // it is behind us
      const rel = this.speed + (o.speedOffset || 0);
      const distance = o.x - (t.x + TREX.width);
      if (intent.action === 'duck') {
        const soon = (distance / rel) * FRAME_MS < 1000;
        if (soon) {
          holdDuck = true;
          if (!t.ducking) { this.setDuck(true); this.intentDuckActive = true; } // in the air: speed drop + crouch on landing
        }
        continue;
      }
      if (intent.action === 'jump' && !jumpedThisFrame) {
        if (t.jumping) continue; // wait for the landing
        const w = this.safeJumpDelays(o, o.x, rel);
        const isNearest = !this.obstacles.some((p) => p !== o && p.x < o.x && p.x + p.width > t.x);
        const lastChance = isNearest && !w.runsUnder && w.firstSafeDelay == null && distance <= rel * 8; // nothing safe left: try anyway
        const pointless = isNearest && w.runsUnder && distance <= rel * 20;                                // the model asked; harmless
        // A jump planned for a farther obstacle must not be started under or into a nearer one.
        if ((w.firstSafeDelay === 0 && this.jumpNowSafeAgainstAll()) || lastChance || pointless) {
          if (this.jump()) { jumpedThisFrame = true; this.intents.delete(o.id); }
        }
      }
    }
    for (const id of Array.from(this.intents.keys())) {
      if (!this.obstacles.some((o) => o.id === id)) this.intents.delete(id);
    }
    if (!holdDuck && this.intentDuckActive) { this.setDuck(false); this.intentDuckActive = false; }
  }

  /** Would a full jump started this frame get past every obstacle currently ahead (with the jitter margin)? */
  jumpNowSafeAgainstAll() {
    const trexX = this.trex.x;
    const groundY = this.groundY;
    const running = TREX.collisionBoxes.running;
    const heights = this.jumpProfile(this.speed).heights;
    const heightAt = (k) => (k < heights.length ? heights[k] : 0);
    for (const o of this.obstacles) {
      if (o.x + o.width <= trexX) continue;
      const rel = this.speed + (o.speedOffset || 0);
      const survives = (x0) => {
        for (let k = 0; k <= 600; k++) {
          const ox = x0 - rel * k;
          if (ox + o.width <= trexX) return true;
          if (k >= heights.length && ox > trexX + TREX.width) return true; // landed before it is anywhere near
          if (trexHitsObstacle(trexX, groundY - heightAt(k), running, o, ox)) return false;
        }
        return true;
      };
      const shift = rel * JITTER_FRAMES;
      if (!survives(o.x) || !survives(o.x + shift) || !survives(o.x - shift)) return false;
    }
    return true;
  }

  /** True if the jump in progress gets past `o` without touching it (from the dino's current height and speed). */
  willClearInCurrentJump(o) {
    const t = this.trex;
    if (!t.jumping) return false;
    const rel = this.speed + (o.speedOffset || 0);
    const running = TREX.collisionBoxes.running;
    let y = t.y;
    let vy = t.vy;
    let reachedMin = t.reachedMinHeight;
    for (let k = 0; k < 400; k++) {
      const ox = o.x - rel * k;
      if (ox + o.width <= t.x) return true;
      if (trexHitsObstacle(t.x, y, running, o, ox)) return false;
      if (k > 0 && y >= this.groundY) return false; // landed while it is still ahead
      y += t.speedDrop ? vy * TREX.speedDropCoefficient : vy;
      vy += TREX.gravity;
      if (y < this.groundY - TREX.minJumpHeight) reachedMin = true;
      if (y < TREX.maxJumpHeight && reachedMin && vy < TREX.dropVelocity) vy = TREX.dropVelocity;
      if (y > this.groundY) y = this.groundY;
    }
    return false;
  }

  // ------------------------------------------------------- agent support --

  /** Everything the agent needs to describe the world to a model. */
  snapshot() {
    const t = this.trex;
    const ahead = this.obstacles
      .filter((o) => o.x + o.width > t.x)
      .sort((a, b) => a.x - b.x)
      .slice(0, 3)
      .map((o) => ({
        id: o.id, type: o.type, size: o.size, x: o.x, y: o.y, width: o.width, height: o.height, speedOffset: o.speedOffset, boxes: o.boxes,
        clearing: this.willClearInCurrentJump(o),                       // the current jump gets past it: nothing left to decide
        planned: this.intents.has(o.id) ? this.intents.get(o.id).action : null,
      }));
    return {
      frame: this.frameCount,
      timeMs: this.runningTime,
      speed: this.speed,
      score: this.score(),
      status: this.status,
      trex: {
        x: t.x, y: t.y, vy: t.vy,
        jumping: t.jumping, ducking: t.ducking,
        heightAboveGround: Math.max(0, Math.round(this.groundY - t.y)),
        landsInMs: t.jumping ? this.landsInMs() : 0,
      },
      obstacles: ahead,
      groundY: this.groundY,
      groundLineY: GROUND_LINE_Y,
    };
  }

  landsInMs() {
    const t = this.trex;
    let y = t.y, vy = t.vy, n = 0;
    while (y < this.groundY && n < 300) { y += vy; vy += TREX.gravity; n++; }
    return Math.round(n * FRAME_MS);
  }

  /**
   * Simulate a full jump at the given speed with the real integrator.
   * Returns heights per frame and a helper telling in which frame range the
   * dino is at or above a required clearance.
   */
  jumpProfile(speed = this.speed) {
    const key = Math.round(speed * 10);
    if (this.profileCache.has(key)) return this.profileCache.get(key);
    let y = this.groundY;
    let vy = TREX.initialJumpVelocity - speed / 10;
    let reachedMin = false;
    const heights = [0];
    for (let n = 0; n < 400; n++) {
      y += vy;
      vy += TREX.gravity;
      if (y < this.groundY - TREX.minJumpHeight) reachedMin = true;
      if (y < TREX.maxJumpHeight && reachedMin && vy < TREX.dropVelocity) vy = TREX.dropVelocity;
      if (y >= this.groundY) break;
      heights.push(this.groundY - y);
    }
    const profile = {
      speed,
      airtimeFrames: heights.length,
      airtimeMs: Math.round(heights.length * FRAME_MS),
      apexPx: Math.round(Math.max(...heights)),
      heights,
      clearance(requiredPx) {
        let first = -1, last = -1;
        heights.forEach((h, i) => { if (h >= requiredPx) { if (first < 0) first = i; last = i; } });
        return first < 0 ? null : { firstFrame: first, lastFrame: last };
      },
    };
    this.profileCache.set(key, profile);
    return profile;
  }

  /** Canvas-space rectangle of the restart button (only meaningful when crashed). */
  restartButtonRect() {
    return { x: (CANVAS.width - RESTART.width) / 2, y: 64, w: RESTART.width, h: RESTART.height };
  }

  // -------------------------------------------------------------- render --

  render() {
    const { ctx, sprite } = this;
    ctx.clearRect(0, 0, CANVAS.width, CANVAS.height);

    for (const c of this.clouds) {
      ctx.drawImage(sprite, CLOUD.sx, CLOUD.sy, CLOUD.width, CLOUD.height, Math.round(c.x), c.y, CLOUD.width, CLOUD.height);
    }
    for (const seg of this.horizon) {
      ctx.drawImage(sprite, seg.src, HORIZON.sy, 600, HORIZON.height, Math.round(seg.x), HORIZON.yPos, 600, HORIZON.height);
    }
    for (const o of this.obstacles) {
      const def = OBSTACLES[o.type];
      const sx = o.type === 'pterodactyl' ? def.sx + o.frame * def.width : def.sx + def.width * o.size * 0.5 * (o.size - 1);
      ctx.drawImage(sprite, sx, def.sy, o.width, o.height, Math.round(o.x), o.y, o.width, o.height);
    }

    const t = this.trex;
    const seq = TREX.frames[t.status];
    let frame = seq[t.frame % seq.length];
    if (t.status === 'waiting') frame = (this.idleTime % 3000) < 180 ? seq[1] : seq[0];
    const w = t.status === 'ducking' ? TREX.widthDuck : TREX.width;
    ctx.drawImage(sprite, TREX.sx + frame, TREX.sy, w, TREX.height, Math.round(t.x), Math.round(t.y), w, TREX.height);

    this.drawScore();
    if (this.config.showHitboxes) this.drawHitboxes();
    if (this.status === 'crashed') this.drawGameOver();
  }

  drawDigits(str, x, y, alpha = 1) {
    const { ctx, sprite } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const ch of str) {
      let index = ch === 'H' ? 10 : ch === 'I' ? 11 : ch === ' ' ? -1 : Number(ch);
      if (index >= 0) ctx.drawImage(sprite, TEXT.sx + index * TEXT.width, TEXT.sy, TEXT.width, TEXT.height, x, y, TEXT.width, TEXT.height);
      x += TEXT.destWidth;
    }
    ctx.restore();
  }

  drawScore() {
    const score = String(Math.min(this.score(), 99999)).padStart(5, '0');
    const scoreX = CANVAS.width - TEXT.destWidth * 5 - 6;
    this.drawDigits(score, scoreX, 5);
    if (this.highScore > 0) {
      const hi = 'HI ' + String(Math.min(this.highScore, 99999)).padStart(5, '0');
      this.drawDigits(hi, scoreX - TEXT.destWidth * 9, 5, 0.6);
    }
  }

  drawHitboxes() {
    const { ctx } = this;
    const t = this.trex;
    ctx.save();
    ctx.lineWidth = 1;
    const tBoxes = t.ducking ? TREX.collisionBoxes.ducking : TREX.collisionBoxes.running;
    ctx.strokeStyle = 'rgba(0, 120, 255, 0.9)';
    for (const b of tBoxes) ctx.strokeRect(t.x + 1 + b.x + 0.5, t.y + 1 + b.y + 0.5, b.w, b.h);
    ctx.strokeStyle = 'rgba(230, 40, 40, 0.9)';
    for (const o of this.obstacles) for (const b of o.boxes) ctx.strokeRect(o.x + 1 + b.x + 0.5, o.y + 1 + b.y + 0.5, b.w, b.h);
    ctx.restore();
  }

  drawGameOver() {
    const { ctx, sprite } = this;
    ctx.drawImage(sprite, GAME_OVER.sx, GAME_OVER.sy, GAME_OVER.width, GAME_OVER.height, (CANVAS.width - GAME_OVER.width) / 2, 44, GAME_OVER.width, GAME_OVER.height);
    const r = this.restartButtonRect();
    ctx.drawImage(sprite, RESTART.sx, RESTART.sy, RESTART.width, RESTART.height, r.x, r.y, RESTART.width, RESTART.height);
  }
}

/** Human-readable obstacle description, shared with the agent. */
export function describeType(o) {
  if (o.type === 'pterodactyl') {
    const band = o.y >= 100 ? 'low' : o.y >= 75 ? 'mid' : 'high';
    return `pterodactyl flying ${band}`;
  }
  const size = o.type === 'cactusLarge' ? 'large' : 'small';
  return o.size > 1 ? `group of ${o.size} ${size} cacti` : `${size} cactus`;
}
