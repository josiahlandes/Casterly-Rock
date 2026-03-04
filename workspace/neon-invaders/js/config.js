// Game Constants - All speeds, sizes, colors, and timings

export const CANVAS = {
    WIDTH: 800,
    HEIGHT: 600
};

export const COLORS = {
    // Background
    BACKGROUND: '#1a1a2e',
    
    // Player
    PLAYER: '#00fff5',
    PLAYER_CORE: '#ffffff',
    PLAYER_BULLET: '#00fff5',
    
    // Enemies
    ENEMY_A: '#ff00ff',  // Drone - magenta
    ENEMY_B: '#ff6600',  // Tank - electric orange
    ENEMY_C: '#39ff14',  // Scout - lime green
    ENEMY_BULLET: '#ff3333',
    ENEMY_HIT_FLASH: '#ffffff',
    
    // Power-ups
    POWERUP: '#ffd700',  // Gold
    
    // Effects
    EXPLOSION_START: '#ffffff',
    EXPLOSION_MID: '#ffff00',
    EXPLOSION_END: '#ff6600',
    PARTICLE_TRAIL: '#00fff5',
    SPARK: '#ffffff',
    
    // HUD
    HUD_TEXT: '#00fff5',
    SHIELD_GRADIENT_START: '#00fff5',
    SHIELD_GRADIENT_END: '#ff00ff',
    COMBO_TEXT: '#ffd700',
    
    // Scan lines
    SCANLINE: 'rgba(255, 255, 255, 0.03)'
};

export const PLAYER = {
    WIDTH: 40,
    HEIGHT: 30,
    SPEED: 300,  // pixels per second
    SHOOT_COOLDOWN: 0.2,  // seconds
    MAX_BULLETS: 3,
    SHIELD_MAX: 3,
    SHIELD_HIT_SIZE: 35,
    THRUSTER_PARTICLES: 3  // particles per frame when moving
};

export const ENEMY = {
    WIDTH: 35,
    HEIGHT: 30,
    GRID_ROWS: 5,
    GRID_COLS: 8,
    GRID_PADDING_X: 40,
    GRID_PADDING_Y: 30,
    GRID_START_Y: 80,
    MOVE_SPEED_BASE: 50,  // pixels per second
    MOVE_SPEED_MAX: 150,
    DROP_DISTANCE: 25,  // pixels down when hitting edge
    FIRE_RATE_BASE: 0.002,  // base fire probability per enemy per frame
    FIRE_RATE_LEVEL_BOOST: 0.001,  // additional per level
    FIRE_RATE_BOOST_EVERY_5: 0.5  // 50% increase every 5 levels
};

export const ENEMY_TYPES = {
    A: {
        name: 'Drone',
        hp: 1,
        points: 100,
        speed: 1.0,
        color: COLORS.ENEMY_A,
        shape: 'diamond',
        appears: 1
    },
    B: {
        name: 'Tank',
        hp: 2,
        points: 250,
        speed: 0.7,
        color: COLORS.ENEMY_B,
        shape: 'hexagon',
        appears: 2
    },
    C: {
        name: 'Scout',
        hp: 1,
        points: 200,
        speed: 1.5,
        color: COLORS.ENEMY_C,
        shape: 'triangle',
        appears: 3
    }
};

export const PROJECTILE = {
    PLAYER_SPEED: 500,
    ENEMY_SPEED: 200,
    PLAYER_WIDTH: 4,
    PLAYER_HEIGHT: 12,
    ENEMY_WIDTH: 5,
    ENEMY_HEIGHT: 10
};

export const PARTICLES = {
    EXPLOSION_COUNT: 20,  // particles per explosion
    EXPLOSION_LIFE: 0.5,  // seconds
    THRUSTER_LIFE: 0.3,
    IMPACT_COUNT: 6,
    IMPACT_LIFE: 0.2,
    POWERUP_COLLECT_COUNT: 12,
    POWERUP_COLLECT_LIFE: 0.4
};

export const POWERUP = {
    WIDTH: 30,
    HEIGHT: 30,
    DROP_SPEED: 80,  // pixels per second
    DESPAWN_Y: 550,
    CHANCE: 0.1,  // 10% chance on enemy death
    DURATION: 8,  // seconds for timed power-ups
    TYPES: {
        RAPID_FIRE: 'R',
        SHIELD_REPAIR: 'S',
        SPREAD_SHOT: 'W'
    }
};

export const COMBO = {
    MAX_TIME: 1.5,  // seconds between kills to maintain combo
    MAX_MULTIPLIER: 5
};

export const LEVEL = {
    TRANSITION_TIME: 2,  // seconds for level transition screen
    START_Y_INCREMENT: 10  // enemies start lower each level
};

export const AUDIO = {
    PLAYER_SHOOT_FREQ: 880,
    PLAYER_SHOOT_DECAY: 0.1,
    ENEMY_SHOOT_FREQ: 440,
    ENEMY_SHOOT_DECAY: 0.08,
    ENEMY_DESTROY_START: 200,
    ENEMY_DESTROY_END: 50,
    ENEMY_DESTROY_DECAY: 0.3,
    PLAYER_HIT_FREQ: 100,
    PLAYER_HIT_DECAY: 0.2,
    POWERUP_NOTES: [523.25, 659.25, 783.99],  // C5, E5, G5
    POWERUP_DECAY: 0.05,
    LEVEL_NOTES: [261.63, 329.63, 392.00, 523.25],  // C4, E4, G4, C5
    LEVEL_DECAY: 0.1,
    GAMEOVER_START: 300,
    GAMEOVER_END: 100,
    GAMEOVER_DECAY: 0.8
};

export const SHADOW_BLUR = 15;
export const GLOW_OPACITY = 0.3;