// Sprite atlas + collision boxes for Chrome's T-Rex runner (1x sheet).
// Coordinates come from Chromium's components/neterror/resources/dino_game
// (offline_sprite_definitions.ts, trex.ts). Sprite sheet © The Chromium Authors,
// BSD-3-Clause — see assets/CHROMIUM-LICENSE.

export const SPRITE_SHEET_URL = 'assets/offline-sprite-1x.png';

export const CANVAS = { width: 600, height: 150, bottomPad: 10 };

export const TREX = {
  sx: 848, sy: 2,
  width: 44, height: 47,
  widthDuck: 59, heightDuck: 25,
  startX: 50,
  // x offsets (relative to sx) of the animation frames in the sheet
  frames: {
    waiting: [44, 0],
    running: [88, 132],
    jumping: [0],
    crashed: [220],
    ducking: [264, 323],
  },
  msPerFrame: { waiting: 1000 / 3, running: 1000 / 12, jumping: 1000 / 60, crashed: 1000 / 60, ducking: 1000 / 8 },
  // physics (per 60fps frame)
  gravity: 0.6,
  initialJumpVelocity: -10,
  dropVelocity: -5,
  minJumpHeight: 30,
  maxJumpHeight: 30,
  speedDropCoefficient: 3,
  collisionBoxes: {
    running: [
      { x: 22, y: 0, w: 17, h: 16 },
      { x: 1, y: 18, w: 30, h: 9 },
      { x: 10, y: 35, w: 14, h: 8 },
      { x: 1, y: 24, w: 29, h: 5 },
      { x: 5, y: 30, w: 21, h: 4 },
      { x: 9, y: 34, w: 15, h: 4 },
    ],
    ducking: [{ x: 1, y: 18, w: 55, h: 25 }],
  },
};

export const OBSTACLES = {
  cactusSmall: {
    label: 'small cactus',
    sx: 228, sy: 2, width: 17, height: 35, yPos: 105,
    multipleSpeed: 4, minGap: 120, minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 7, w: 5, h: 27 },
      { x: 4, y: 0, w: 6, h: 34 },
      { x: 10, y: 4, w: 7, h: 14 },
    ],
  },
  cactusLarge: {
    label: 'large cactus',
    sx: 332, sy: 2, width: 25, height: 50, yPos: 90,
    multipleSpeed: 7, minGap: 120, minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 12, w: 7, h: 38 },
      { x: 8, y: 0, w: 7, h: 49 },
      { x: 13, y: 10, w: 10, h: 38 },
    ],
  },
  pterodactyl: {
    label: 'pterodactyl',
    sx: 134, sy: 2, width: 46, height: 40,
    yPos: [100, 75, 50], // low (ground level) / mid (head height) / high (run under)
    multipleSpeed: 999, minGap: 150, minSpeed: 0,
    speedOffset: 0.8,
    numFrames: 2, frameRate: 1000 / 6,
    collisionBoxes: [
      { x: 15, y: 15, w: 16, h: 5 },
      { x: 18, y: 21, w: 24, h: 6 },
      { x: 2, y: 14, w: 4, h: 3 },
      { x: 6, y: 10, w: 4, h: 7 },
      { x: 10, y: 8, w: 6, h: 9 },
    ],
  },
};

export const CLOUD = { sx: 86, sy: 2, width: 46, height: 14, minSky: 30, maxSky: 71, minGap: 100, maxGap: 400, maxClouds: 6, speed: 0.2, frequency: 0.5 };
export const HORIZON = { sx: 2, sy: 54, width: 1200, height: 12, yPos: 127 };
export const TEXT = { sx: 655, sy: 2, width: 10, height: 13, destWidth: 11 }; // digits 0-9, then H (10), I (11)
export const GAME_OVER = { sx: 655, sy: 15, width: 191, height: 11 };
export const RESTART = { sx: 2, sy: 68, width: 36, height: 32 };

export const RUNNER = {
  fps: 60,
  acceleration: 0.001,
  gapCoefficient: 0.6,
  maxGapCoefficient: 1.5,
  maxObstacleLength: 3,
  maxObstacleDuplication: 2,
  maxSpeed: 13,
  minSpeed: 3,
  defaultSpeed: 6,
  clearTimeMs: 2000,         // no obstacles during the first moments of a run
  scoreCoefficient: 0.025,
};

export function loadSpriteSheet() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${SPRITE_SHEET_URL}`));
    img.src = SPRITE_SHEET_URL;
  });
}
