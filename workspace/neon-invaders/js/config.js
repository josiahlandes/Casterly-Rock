// Game configuration constants

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

// Colors
export const COLORS = {
    background: '#1a1a2e',
    player: '#00fff5',
    playerCore: '#ffffff',
    enemyA: '#ff00ff',
    enemyB: '#ff6600',
    enemyC: '#39ff14',
    enemyBullet: '#ff3333',
    powerup: '#ffd700',
    shield: '#00fff5',
    shieldGradientEnd: '#ff00ff',
    text: '#00fff5',
    white: '#ffffff',
    yellow: '#ffff00',
    orange: '#ff6600',
    grid: '#2a2a4e',
    star: '#ffffff',
    scanline: '#1a1a3e'
};

// Player settings
export const PLAYER = {
    width: 40,
    height: 30,
    speed: 300,
    maxShield: 3,
    fireRate: 0.2, // seconds between shots
    maxBullets: 3,
    shieldHitPoints: 3
};

// Enemy settings
export const ENEMY = {
    width: 35,
    height: 25,
    baseSpeed: 50,
    speedIncreasePerKill: 0.5,
    fireRate: 0.003, // per enemy per second
    fireRateMultiplier: 1, // increases every 5 levels
    formationRows: 5,
    formationCols: 8,
    rowSpacing: 50,
    colSpacing: 60,
    startMarginTop: 80,
    startMarginSide: 50,
    dropDistance: 25,
    idlePulseSpeed: 2
};

// Enemy type specifics
export const ENEMY_TYPES = {
    A: {
        hp: 1,
        points: 100,
        speed: 1,
        color: COLORS.enemyA,
        shape: 'diamond'
    },
    B: {
        hp: 2,
        points: 250,
        speed: 0.7,
        color: COLORS.enemyB,
        shape: 'hexagon'
    },
    C: {
        hp: 1,
        points: 200,
        speed: 1.5,
        color: COLORS.enemyC,
        shape: 'triangle'
    }
};

// Projectile settings
export const PROJECTILE = {
    playerSpeed: 500,
    enemySpeed: 200,
    playerWidth: 4,
    playerHeight: 15,
    enemyWidth: 6,
    enemyHeight: 12,
    maxPlayerBullets: 3
};

// Power-up settings
export const POWERUP = {
    dropChance: 0.1,
    width: 30,
    height: 30,
    fallSpeed: 80,
    pulseSpeed: 3,
    duration: 8, // seconds for active effects
    types: ['rapid', 'shield', 'spread']
};

// Particle settings
export const PARTICLE = {
    explosionCount: 20,
    explosionLife: 0.5,
    thrusterCount: 3,
    thrusterLife: 0.3,
    impactCount: 6,
    impactLife: 0.2,
    powerupCount: 12,
    powerupLife: 0.4
};

// Combo settings
export const COMBO = {
    maxCombo: 5,
    resetTime: 1.5 // seconds
};

// Level settings
export const LEVEL = {
    transitionTime: 2, // seconds
    startRowOffset: 0,
    rowOffsetPerLevel: 10,
    fireRateLevelInterval: 5
};

// Game settings
export const GAME = {
    comboResetTime: 1.5,
    highScoreKey: 'neonInvadersHighScore'
};

// Audio settings
export const AUDIO = {
    enabled: true,
    volume: 0.3
};

// Input settings
export const INPUT = {
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    shoot: ['Space'],
    start: ['Enter']
};