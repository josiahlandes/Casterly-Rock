// Neon Invaders - Power-ups
// Handles power-up drops, collection, and effects

import { CANVAS_WIDTH, CANVAS_HEIGHT, POWERUP, COLORS, GLOW } from './config.js';

export class PowerUp {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.width = POWERUP.width;
    this.height = POWERUP.height;
    this.active = true;
    this.pulseTime = 0;
    
    // Set properties based on type
    switch (type) {
      case 'rapid':
        this.label = 'R';
        this.color = '#ff6600'; // Orange for rapid fire
        break;
      case 'shield':
        this.label = 'S';
        this.color = '#00fff5'; // Cyan for shield
        break;
      case 'spread':
        this.label = 'W';
        this.color = '#ff00ff'; // Magenta for spread
        break;
    }
  }

  update(dt, gameTime) {
    // Move downward
    this.y += POWERUP.dropSpeed * dt;
    
    // Update pulse animation
    this.pulseTime += dt * POWERUP.pulseSpeed;
    
    // Deactivate if off screen
    if (this.y > CANVAS_HEIGHT + this.height) {
      this.active = false;
    }
  }

  getBounds() {
    return {
      x: this.x - this.width / 2,
      y: this.y - this.height / 2,
      width: this.width,
      height: this.height
    };
  }

  draw(ctx) {
    const pulseScale = 1 + Math.sin(this.pulseTime) * 0.1;
    
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(pulseScale, pulseScale);
    
    // Draw glow effect
    ctx.shadowBlur = GLOW.glowShadowBlur;
    ctx.shadowColor = COLORS.powerup;
    
    // Draw power-up outline (rounded rectangle)
    ctx.strokeStyle = COLORS.powerup;
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(255, 215, 0, 0.2)';
    
    const w = this.width / 2;
    const h = this.height / 2;
    const r = 5; // corner radius
    
    ctx.beginPath();
    ctx.moveTo(-w + r, -h);
    ctx.lineTo(w - r, -h);
    ctx.quadraticCurveTo(w, -h, w, -h + r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(-w + r, h);
    ctx.quadraticCurveTo(-w, h, -w, h - r);
    ctx.lineTo(-w, -h + r);
    ctx.quadraticCurveTo(-w, -h, -w + r, -h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Draw label
    ctx.shadowBlur = 0;
    ctx.fillStyle = this.color;
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, 0, 0);
    
    ctx.restore();
  }
}

export class PowerUpManager {
  constructor() {
    this.powerups = [];
    this.activeEffects = new Map(); // Track active power-up effects
  }

  // Create a power-up at position
  create(x, y) {
    // Randomly select type
    const type = POWERUP.types[Math.floor(Math.random() * POWERUP.types.length)];
    const powerup = new PowerUp(x, y, type);
    this.powerups.push(powerup);
    return powerup;
  }

  // Check if player collected a power-up
  checkCollection(playerBounds) {
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      const powerupBounds = p.getBounds();
      
      // Simple AABB collision
      if (
        playerBounds.x < powerupBounds.x + powerupBounds.width &&
        playerBounds.x + playerBounds.width > powerupBounds.x &&
        playerBounds.y < powerupBounds.y + powerupBounds.height &&
        playerBounds.y + playerBounds.height > powerupBounds.y
      ) {
        // Activate effect
        this.activateEffect(p.type);
        this.powerups.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Activate a power-up effect
  activateEffect(type) {
    const now = performance.now();
    const endTime = now + POWERUP.duration;
    
    switch (type) {
      case 'rapid':
        this.activeEffects.set('rapid', endTime);
        break;
      case 'shield':
        // Shield repair is applied immediately by the caller
        break;
      case 'spread':
        this.activeEffects.set('spread', endTime);
        break;
    }
  }

  // Check if a power-up effect is active
  isEffectActive(type) {
    if (!this.activeEffects.has(type)) return false;
    
    const endTime = this.activeEffects.get(type);
    if (performance.now() > endTime) {
      this.activeEffects.delete(type);
      return false;
    }
    return true;
  }

  // Get remaining time for an effect (in ms)
  getEffectRemaining(type) {
    if (!this.activeEffects.has(type)) return 0;
    
    const endTime = this.activeEffects.get(type);
    const remaining = endTime - performance.now();
    return Math.max(0, remaining);
  }

  // Update all power-ups
  update(dt) {
    // Update active effects (remove expired)
    for (const [type, endTime] of this.activeEffects) {
      if (performance.now() > endTime) {
        this.activeEffects.delete(type);
      }
    }
    
    // Update power-up positions
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      p.update(dt);
      
      if (!p.active) {
        this.powerups.splice(i, 1);
      }
    }
  }

  // Draw all power-ups
  draw(ctx) {
    this.powerups.forEach(p > p.draw(ctx));
  }

  // Clear all power-ups and effects
  clear() {
    this.powerups = [];
    this.activeEffects.clear();
  }

  // Get all power-ups (for external access if needed)
  getAll() {
    return this.powerups;
  }
}

export default PowerUpManager;
