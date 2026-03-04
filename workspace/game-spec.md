# Neon Invaders — Full Game Spec

Build a complete Space Invaders clone called **Neon Invaders** using vanilla JavaScript and HTML5 Canvas. No libraries, no frameworks. One `index.html` entry point and separate JS module files loaded via ES modules (`<script type="module">`). The game should run by opening `index.html` in a browser — no build step.

Create all files inside a new directory: `projects/neon-invaders/`

---

## File Structure

```
projects/neon-invaders/
  index.html          — Canvas, minimal CSS, loads main.js
  js/
    main.js           — Game loop, state machine, entry point
    config.js         — All constants (speeds, sizes, colors, timings)
    input.js          — Keyboard input handler
    player.js         — Player ship (movement, shooting, shields)
    enemies.js        — Enemy grid, formation movement, attack patterns
    projectiles.js    — Bullets, missiles (player + enemy)
    particles.js      — Particle system (explosions, trails, sparks)
    powerups.js       — Power-up drops and effects
    hud.js            — Score, lives, level, shield bar, combo display
    audio.js          — Procedural sound via Web Audio API (no files)
    background.js     — Animated background (grid, stars, scan lines)
    collision.js      — AABB collision detection
    levels.js         — Level progression, wave definitions
```

---

## Visual Theme: Futuristic Neon

**Background**: Dark charcoal gray (#1a1a2e) with:
- Subtle perspective grid lines fading toward a vanishing point (like an 80s retrowave floor)
- Slowly drifting star field (tiny white dots, varied brightness, parallax at 2 depths)
- Faint horizontal scan line effect (semi-transparent lines scrolling down)

**Color Palette** (all elements glow against the dark background):
- Player ship: Cyan (#00fff5) with white core
- Player bullets: Bright cyan bolts with short trailing glow
- Enemy Type A (basic): Magenta (#ff00ff) — simple geometric shape
- Enemy Type B (armored): Electric orange (#ff6600) — takes 2 hits, flashes on first hit
- Enemy Type C (fast): Lime green (#39ff14) — moves faster, appears from level 3+
- Enemy bullets: Red-orange (#ff3333) with slight glow
- Explosions: White → yellow → orange → fade (particle burst)
- Power-ups: Pulsing gold (#ffd700) outline
- HUD text: Cyan with subtle glow, monospace font
- Shield bar: Gradient cyan to magenta

**Glow Effect**: Draw key elements twice — once at full opacity, once larger at ~0.3 opacity with blur via `shadowBlur` on the canvas context. This creates the neon glow.

---

## Game Mechanics

### Player Ship
- Positioned near bottom of screen, moves left/right with Arrow keys or A/D
- Shoots with Space bar (max 3 player bullets on screen at once)
- Has a shield with 3 hit points (shown as a bar above the HUD)
- Slight acceleration/deceleration for smooth movement (not instant stop)
- Thruster particle trail when moving (small cyan sparks downward)

### Enemy Grid
- Classic formation: 5 rows x 8 columns, starting near the top
- Formation moves horizontally, shifts down one row when hitting screen edge
- Movement speed increases as enemies are destroyed (classic Space Invaders behavior)
- Each enemy has a small idle animation (gentle pulse/glow cycle)
- Random enemies fire bullets downward (frequency increases with level)

### Enemy Types
| Type | HP | Points | Speed | Visual | Appears |
|------|-----|--------|-------|--------|---------|
| A (Drone) | 1 | 100 | Normal | Magenta diamond | Level 1+ |
| B (Tank) | 2 | 250 | Slow | Orange hexagon, flashes white on hit | Level 2+ |
| C (Scout) | 1 | 200 | Fast | Green triangle, jitters | Level 3+ |

### Levels & Waves
- Level 1: All Type A
- Level 2: Mix A + B (back rows are B)
- Level 3+: Mix A + B + C (C in front row, B in back)
- Each level: enemies start one row lower than the previous
- Between levels: brief "LEVEL X" title screen with fade (2 seconds)
- Every 5 levels: enemies fire 50% more frequently

### Power-ups
Randomly dropped when an enemy is destroyed (~10% chance):
- **Rapid Fire** (R): Fire rate doubles for 8 seconds. Icon: double arrow up.
- **Shield Repair** (S): Restores 1 shield point. Icon: shield shape.
- **Spread Shot** (W): Fires 3 bullets in a fan for 8 seconds. Icon: triple arrow.

Power-ups drift downward slowly, pulsing gold, and despawn if they reach the bottom.

### Combo System
- Killing enemies in quick succession (within 1.5 seconds) builds a combo
- Combo multiplier: x2, x3, x4, x5 (max)
- Display combo text briefly when multiplier increases ("x3 COMBO!" in large glowing text, fades quickly)
- Combo resets after 1.5 seconds of no kills

### Scoring
- Base points per enemy type (see table) multiplied by combo multiplier
- Displayed in HUD top-left, with a brief "pop" scale animation when score changes

### Game Over
- When shield reaches 0 and player is hit, OR enemies reach the player's row
- Screen flashes white briefly, then fade to "GAME OVER" screen
- Show final score, level reached, and "Press ENTER to restart"
- High score persisted in localStorage

---

## Particle System

Particles are lightweight objects: `{ x, y, vx, vy, life, maxLife, color, size }`.

**Explosion** (enemy destroyed): Burst of 15-25 particles in the enemy's color, radiating outward with random velocities, fading out over 0.5s. Particles shrink as they fade.

**Player thruster**: Stream of 2-3 tiny cyan particles per frame when moving, drifting downward with slight spread, short life (0.3s).

**Bullet impact** (bullet hits something): Small burst of 5-8 sparks in bullet color.

**Power-up collect**: Ring of 12 gold particles expanding outward.

---

## Procedural Audio (Web Audio API)

Generate all sounds procedurally — no audio files.

- **Player shoot**: Short high-pitched "pew" — sine wave 880Hz, quick decay (0.1s), slight frequency sweep down
- **Enemy shoot**: Lower "thwip" — triangle wave 440Hz, 0.08s decay
- **Enemy destroyed**: Noise burst + sine sweep down (0.3s) — white noise mixed with 200Hz→50Hz sweep
- **Player hit**: Low thud — sine 100Hz, 0.2s, slight distortion via waveshaper
- **Power-up collect**: Ascending arpeggio — three quick sine tones (C5, E5, G5) at 0.05s each
- **Level complete**: Short triumphant jingle — ascending notes (C4, E4, G4, C5) at 0.1s each
- **Game over**: Descending sad tone — 300Hz→100Hz sine sweep over 0.8s

Keep a single AudioContext, create oscillators/nodes on demand, disconnect after playback.

---

## Canvas Setup

- Canvas size: 800 x 600 pixels, centered in viewport
- Background: Fill with #1a1a2e each frame (or use the background module)
- Use `requestAnimationFrame` with delta-time for consistent speed
- All coordinates relative to canvas (not window)

---

## Game State Machine

States: `menu` → `playing` → `levelTransition` → `playing` → `gameOver` → `menu`

- **menu**: Title "NEON INVADERS" in large glowing cyan text, "Press ENTER to start", high score shown
- **playing**: Active gameplay
- **levelTransition**: "LEVEL X" displayed for 2 seconds, then spawn next wave
- **gameOver**: Final score, high score, restart prompt

---

## Implementation Notes

- Use `requestAnimationFrame` with delta time — do NOT use `setInterval`
- Keep the game loop clean: `update(dt)` then `draw(ctx)`
- Each module exports a class or factory function
- The particle system should handle hundreds of particles without lag — use object pooling or simple arrays
- Enemy formation logic: track grid offset, move as a group, remove individuals on death
- Collision detection: simple AABB (axis-aligned bounding boxes), checked each frame
- All config values (speeds, sizes, colors, timings) in `config.js` for easy tuning

Build the complete game. Every file, every function, every detail. Make it playable.
