// Game Constants Configuration

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

export const COLORS = {
    background: '#1a1a2e',
    player: '#00fff5',
    playerCore: '#ffffff',
    enemyA: '#ff00ff',
    enemyB: '#ff6600',
    enemyC: '#39ff14',
    enemyBullet: '#ff3333',
    powerUp: '#ffd700',
    hudText: '#00fff5',
    shieldStart: '#00fff5',
    shieldEnd: '#ff00ff',
    white: '#ffffff',
    yellow: '#ffff00',
    orange: '#ff6600',
    scanLine: 'rgba(255, 255, 255, 0.03)'
};

export const PLAYER = {
    width: 40,
    height: 30,
    speed: 500,
    maxSpeed: 400,
    acceleration: 800,
    deceleration: 600,
    shieldMax: 3,
    shootCooldown: 0.15,
    maxBullets: 3,
    thrusterParticleRate: 0.05,
    thrusterParticleCount: 2
};

export const ENEMIES = {
    rows: 5,
    cols: 8,
    startX: 80,
    startY: 80,
    spacingX: 60,
    spacingY: 45,
    baseSpeed: 50,
    speedIncreasePerKill: 3,
    maxSpeed: 200,
    edgeShiftAmount: 20,
    fireRate: 0.02,
    fireRateMultiplier: 1.0,
    idlePulseSpeed: 2,
    idlePulseAmount: 0.15
};

export const ENEMY_TYPES = {
    A: {
        type: 'drone',
        hp: 1,
        points: 100,
        speedMultiplier: 1.0,
        color: COLORS.enemyA,
        width: 35,
        height: 25,
        appearsAtLevel: 1
    },
    B: {
        type: 'tank',
        hp: 2,
        points: 250,
        speedMultiplier: 0.7,
        color: COLORS.enemyB,
        width: 40,
        height: 30,
        appearsAtLevel: 2
    },
    C: {
        type: 'scout',
        hp: 1,
        points: 200,
        speedMultiplier: 1.5,
        color: COLORS.enemyC,
        width: 30,
        height: 25,
        appearsAtLevel: 3
    }
};

export const PROJECTILES = {
    player: {
        width: 4,
        height: 15,
        speed: 700,
        color: COLORS.player
    },
    enemy: {
        width: 6,
        height: 12,
        speed: 300,
        color: COLORS.enemyBullet
    }
};

export const POWERUPS = {
    dropChance: 0.1,
    width: 25,
    height: 25,
    speed: 80,
    pulseSpeed: 3,
    pulseAmount: 0.3,
    duration: 8,
    types: {
        R: {
            id: 'rapidFire',
            label: 'R',
            color: COLORS.player,
            effect: 'rapidFire'
        },
        S: {
            id: 'shieldRepair',
            label: 'S',
            color: COLORS.shieldStart,
            effect: 'shieldRepair'
        },
        W: {
            id: 'spreadShot',
            label: 'W',
            color: COLORS.enemyC,
            effect: 'spreadShot'
        }
    }
};

export const PARTICLES = {
    explosionCount: { min: 15, max: 25 },
    explosionLife: 0.5,
    thrusterLife: 0.3,
    impactCount: { min: 5, max: 8 },
    impactLife: 0.2,
    powerUpCollectCount: 12,
    powerUpCollectLife: 0.4,
    maxParticles: 500
};

export const COMBO = {
    maxTime: 1.5,
    maxMultiplier: 5,
    textDisplayTime: 0.8,
    textScale: 2.5
};

export const LEVEL = {
    transitionTime: 2,
    startRowOffset: 0,
    rowOffsetPerLevel: 10,
    increasedFireEvery: 5,
    increasedFireMultiplier: 1.5
};

export const ANIMATION = {
    glowBlur: 15,
    glowOpacity: 0.3,
    scorePopScale: 1.3,
    scorePopDuration: 0.15,
    flashDuration: 0.1
};

export const AUDIO = {
    playerShoot: { freq: 880, decay: 0.1, sweep: -200, type: 'sine' },
    enemyShoot: { freq: 440, decay: 0.08, type: 'triangle' },
    enemyDestroy: { noiseDuration: 0.3, startFreq: 200, endFreq: 50 },
    playerHit: { freq: 100, decay: 0.2, type: 'sine' },
    powerUpCollect: { notes: [523.25, 659.25, 783.99], duration: 0.05 },
    levelComplete: { notes: [261.63, 329.63, 392.00, 523.25], duration: 0.1 },
    gameOver: { startFreq: 300, endFreq: 100, duration: 0.8 }
};

export const STATES = {
    MENU: 'menu',
    PLAYING: 'playing',
    LEVEL_TRANSITION: 'levelTransition',
    GAME_OVER: 'gameOver'
};

export const HIGH_SCORE_KEY = 'neonInvadersHighScore';
