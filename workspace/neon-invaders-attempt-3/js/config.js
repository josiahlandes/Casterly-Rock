// Neon Invaders - Game Configuration
// All constants for speeds, sizes, colors, and timings

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

// Colors
export const COLORS = {
  background: '#1a1a2e',
  player: '#00fff5',
  playerCore: '#ffffff',
  playerBullet: '#00fff5',
  enemyA: '#ff00ff',      // Drone - magenta
  enemyB: '#ff6600',      // Tank - electric orange
  enemyC: '#39ff14',      // Scout - lime green
  enemyBullet: '#ff3333', // Red-orange
  explosion: ['#ffffff', '#ffff00', '#ff8800', '#ff4400'],
  powerup: '#ffd700',     // Gold
  hudText: '#00fff5',
  shieldBar: ['#00fff5', '#ff00ff'],
  grid: 'rgba(0, 255, 245, 0.1)',
  stars: '#ffffff',
  scanline: 'rgba(0, 0, 0, 0.1)',
  comboText: '#ffd700'
};

// Player settings
export const PLAYER = {
  width: 40,
  height: 30,
  speed: 400,           // pixels per second
  maxBullets: 3,
  fireCooldown: 200,    // ms between shots
  shieldMax: 3,
  thrusterParticleRate: 0.05  // particles per frame when moving
};

// Enemy settings
export const ENEMY = {
  width: 35,
  height: 30,
  gridRows: 5,
  gridCols: 8,
  startX: 50,
  startY: 50,
  horizontalSpacing: 55,
  verticalSpacing: 45,
  baseMoveSpeed: 50,    // pixels per second
  moveDownAmount: 30,   // pixels down when hitting edge
  fireChance: 0.0005,   // base chance per frame per enemy
  idlePulseSpeed: 2     // radians per second
};

// Enemy type specifics
export const ENEMY_TYPES = {
  A: { // Drone
    hp: 1,
    points: 100,
    color: COLORS.enemyA,
    shape: 'diamond',
    speedMultiplier: 1.0,
    appearsFromLevel: 1
  },
  B: { // Tank
    hp: 2,
    points: 250,
    color: COLORS.enemyB,
    shape: 'hexagon',
    speedMultiplier: 0.7,
    appearsFromLevel: 2
  },
  C: { // Scout
    hp: 1,
    points: 200,
    color: COLORS.enemyC,
    shape: 'triangle',
    speedMultiplier: 1.5,
    appearsFromLevel: 3
  }
};

// Projectile settings
export const PROJECTILE = {
  playerSpeed: 600,
  enemySpeed: 250,
  width: 4,
  height: 12,
  enemyFireRateMultiplier: 1.0  // increases every 5 levels
};

// Power-up settings
export const POWERUP = {
  width: 25,
  height: 25,
  dropSpeed: 100,
  pulseSpeed: 3,
  spawnChance: 0.1,     // 10% chance on enemy death
  duration: 8000,       // 8 seconds for active power-ups
  types: ['rapid', 'shield', 'spread']
};

// Particle settings
export const PARTICLE = {
  explosionCount: { min: 15, max: 25 },
  explosionLife: 0.5,   // seconds
  explosionSpeed: { min: 50, max: 150 },
  thrusterLife: 0.3,
  thrusterSpeed: 80,
  impactCount: { min: 5, max: 8 },
  impactLife: 0.2,
  powerupRingCount: 12,
  powerupRingLife: 0.4
};

// Combo settings
export const COMBO = {
  maxMultiplier: 5,
  resetTime: 1.5,       // seconds without kills to reset
  displayTime: 0.8      // how long combo text shows
};

// Level settings
export const LEVEL = {
  transitionTime: 2,    // seconds showing "LEVEL X"
  startRowOffset: 0,    // first level starts at startY
  rowOffsetPerLevel: 10, // each level starts lower
  maxEnemyFireIncrease: 0.5  // 50% more fire every 5 levels
};

// Background settings
export const BACKGROUND = {
  starCount: 100,
  starDepth: 2,         // parallax layers
  gridLineSpacing: 40,
  scanlineSpeed: 30,    // pixels per second
  scanlineHeight: 4
};

// Audio settings
export const AUDIO = {
  volume: 0.3,
  enabled: true
};

// Game state timings
export const GAME = {
  menuFadeTime: 0.5,
  gameOverFadeTime: 1.0,
  scorePopTime: 0.2     // how long score "pops" when changed
};

// Glow effect settings
export const GLOW = {
  mainShadowBlur: 15,
  glowShadowBlur: 25,
  glowOpacity: 0.3
};
