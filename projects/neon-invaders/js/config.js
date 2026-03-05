// Neon Invaders - Game Configuration
export const CONFIG = {
    // Canvas
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    
    // Colors
    COLORS: {
        BACKGROUND: '#1a1a2e',
        PLAYER: '#00fff5',
        PLAYER_CORE: '#ffffff',
        ENEMY_A: '#ff00ff',      // Drone
        ENEMY_B: '#ff6600',      // Tank
        ENEMY_C: '#39ff14',      // Scout
        ENEMY_BULLET: '#ff3333',
        POWERUP: '#ffd700',
        SHIELD: '#00fff5',
        COMBO_TEXT: '#ffffff',
        GRID: '#2a2a4e',
        STAR: '#ffffff',
        SCANLINE: 'rgba(255, 255, 255, 0.03)'
    },
    
    // Player
    PLAYER_WIDTH: 40,
    PLAYER_HEIGHT: 30,
    PLAYER_SPEED: 400,           // pixels per second
    PLAYER_SPEED_ACCEL: 2000,
    PLAYER_SPEED_DECEL: 1500,
    MAX_PLAYER_BULLETS: 3,
    SHOOT_COOLDOWN: 0.2,         // seconds
    SHIELD_MAX: 3,
    THRUSTER_PARTICLES: 3,
    
    // Enemy
    ENEMY_WIDTH: 35,
    ENEMY_HEIGHT: 30,
    ENEMY_ROWS: 5,
    ENEMY_COLS: 8,
    ENEMY_PADDING: 15,
    ENEMY_START_Y: 80,
    ENEMY_BASE_SPEED: 50,        // pixels per second
    ENEMY_DROP_DISTANCE: 30,
    ENEMY_A_SPEED: 1,            // relative speed multiplier
    ENEMY_B_SPEED: 0.7,
    ENEMY_C_SPEED: 1.5,
    ENEMY_A_HP: 1,
    ENEMY_B_HP: 2,
    ENEMY_C_HP: 1,
    ENEMY_A_POINTS: 100,
    ENEMY_B_POINTS: 250,
    ENEMY_C_POINTS: 200,
    
    // Enemy formation
    FORMATION_MOVE_SPEED: 50,
    FORMATION_DROP_SPEED: 150,
    
    // Projectiles
    PLAYER_BULLET_SPEED: 600,
    PLAYER_BULLET_WIDTH: 4,
    PLAYER_BULLET_HEIGHT: 12,
    ENEMY_BULLET_SPEED: 250,
    ENEMY_BULLET_WIDTH: 6,
    ENEMY_BULLET_HEIGHT: 10,
    
    // Power-ups
    POWERUP_WIDTH: 30,
    POWERUP_HEIGHT: 30,
    POWERUP_SPEED: 80,
    POWERUP_CHANCE: 0.1,         // 10%
    POWERUP_DURATION: 8,         // seconds
    POWERUP_PULSE_SPEED: 3,
    
    // Particles
    MAX_PARTICLES: 500,
    EXPLOSION_PARTICLES: 20,
    THRUSTER_PARTICLES: 2,
    IMPACT_PARTICLES: 6,
    POWERUP_PARTICLES: 12,
    
    // Combo
    COMBO_WINDOW: 1.5,           // seconds
    MAX_COMBO: 5,
    
    // Levels
    LEVEL_START_Y_OFFSET: 10,
    LEVEL_TRANSITION_TIME: 2,    // seconds
    LEVEL_BONUS_FREQUENCY: 5,    // every 5 levels
    BONUS_FREQUENCY_MULTIPLIER: 1.5,
    
    // Timings
    SHIELD_FLASH_TIME: 0.2,
    SCORE_POP_TIME: 0.15,
    COMBO_TEXT_TIME: 0.8,
    
    // Audio
    AUDIO_ENABLED: true,
    
    // High score
    HIGHSCORE_KEY: 'neonInvadersHighScore'
};