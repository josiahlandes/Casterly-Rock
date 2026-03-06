# Neon Invaders

A complete **Space Invaders clone** built with vanilla JavaScript and HTML5 Canvas. No libraries, no frameworks — just pure JavaScript.

## Features

### Visual Theme
- **Futuristic neon aesthetic** with dark charcoal background (#1a1a2e)
- Perspective grid, drifting star field, and scan line effects
- Glowing neon colors: cyan player, mag/orange/green enemies, gold power-ups
- Glow effects using canvas `shadowBlur`

### Gameplay
- **Player ship** with smooth movement (Arrow keys/A/D) and shooting (Space)
- **Shield system** with 3 hit points
- **Three enemy types**:
  - Type A (Drone): Basic, 1 HP, magenta diamond
  - Type B (Tank): Armored, 2 HP, orange hexagon
  - Type C (Scout): Fast, 1 HP, green triangle
- **Combo system** - quick kills build multipliers up to x5
- **Power-ups** with 10% drop chance: Rapid Fire, Shield Repair, Spread Shot
- **Progressive levels** with increasing difficulty

### Technical
- **No dependencies** - pure vanilla JS with ES modules
- **Procedural audio** via Web Audio API (no sound files)
- **Particle system** for explosions, thruster trails, and effects
- **Game state machine**: menu → playing → level transition → game over
- **800x600 pixel canvas** with `requestAnimationFrame`
- **High score persistence** using localStorage

## How to Run

1. Clone or download this project
2. Open `index.html` in any modern browser
3. No build step or server required!

### Controls
- **Arrow keys / A-D**: Move left/right
- **Space**: Shoot
- **Enter**: Start game / restart

## File Structure

```
projects/neon-invaders/
├── index.html          # Canvas, minimal CSS, loads main.js
└── js/
    ├── main.js         # Game loop, state machine, entry point
    ├── config.js       # All constants (speeds, sizes, colors, timings)
    ├── input.js        # Keyboard input handler
    ├── player.js       # Player ship (movement, shooting, shields)
    ├── enemies.js      # Enemy grid, formation movement, attack patterns
    ├── projectiles.js  # Bullets, missiles (player + enemy)
    ├── particles.js    # Particle system (explosions, trails, sparks)
    ├── powerups.js     # Power-up drops and effects
    ├── hud.js          # Score, lives, level, shield bar, combo display
    ├── audio.js        # Procedural sound via Web Audio API
    ├── background.js   # Animated background (grid, stars, scan lines)
    ├── collision.js    # AABB collision detection
    └── levels.js       # Level progression, wave definitions
```

## Game Mechanics

### Scoring
- Type A (Drone): 100 points
- Type B (Tank): 250 points
- Type C (Scout): 200 points
- Points multiplied by combo multiplier (x2-x5)

### Power-ups
- **Rapid Fire (R)**: Double fire rate for 8 seconds
- **Shield Repair (S)**: Restore 1 shield point
- **Spread Shot (W)**: Fire 3 bullets in a fan for 8 seconds

### Game Over
- Shield reaches 0 and player is hit, OR
- Enemies reach the player's row

## Built With
- HTML5 Canvas
- Vanilla JavaScript (ES Modules)
- Web Audio API

---

**No frameworks. No libraries. Just pure JavaScript.**