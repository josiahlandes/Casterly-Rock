// Game configuration and constants
export const CONFIG = {
  // Canvas dimensions
  CANVAS_WIDTH: 800,
  CANVAS_HEIGHT: 600,
  
  // Player settings
  PLAYER_SPEED: 5,
  PLAYER_WIDTH: 40,
  PLAYER_HEIGHT: 30,
  PLAYER_COLOR: '#00ffff',
  PLAYER_GLOW: 20,
  
  // Projectile settings
  PROJECTILE_SPEED: 8,
  PROJECTILE_WIDTH: 4,
  PROJECTILE_HEIGHT: 15,
  PROJECTILE_COLOR: '#ff00ff',
  
  // Enemy settings
  ENEMY_WIDTH: 35,
  ENEMY_HEIGHT: 25,
  ENEMY_PADDING: 15,
  ENEMY_ROWS: 5,
  ENEMY_COLS: 10,
  ENEMY_SPEED_BASE: 1,
  ENEMY_DROP_DISTANCE: 20,
  
  // Enemy colors (by row)
  ENEMY_COLORS: [
    '#ff0066', // Top row - pink/red
    '#ff6600', // Second row - orange
    '#ffff00', // Third row - yellow
    '#00ff00', // Fourth row - green
    '#0066ff'  // Bottom row - blue
  ],
  
  // Power-up settings
  POWERUP_WIDTH: 25,
  POWERUP_HEIGHT: 25,
  POWERUP_COLOR: '#ffff00',
  POWERUP_DROP_RATE: 0.002, // Chance per enemy kill
  
  // Particle settings
  MAX_PARTICLES: 200,
  PARTICLE_LIFETIME: 30,
  
  // Game state
  INITIAL_LIVES: 3,
  INITIAL_LEVEL: 1,
  COMBO_WINDOW: 1000, // ms to chain kills for combo
  COMBO_MULTIPLIER: 1.5,
  
  // Audio settings
  AUDIO_ENABLED: true,
  MASTER_VOLUME: 0.3
};

export const POWERUP_TYPES = {
  SPREAD_SHOT: 'spread',
  RAPID_FIRE: 'rapid',
  SHIELD: 'shield',
  EXTRA_LIFE: 'life'
};

export const GAME_STATES = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAME_OVER: 'gameOver',
  VICTORY: 'victory'
};
