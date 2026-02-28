// Power-up system for Neon Invaders
import { CONFIG } from './config.js';

export class PowerUp {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.width = CONFIG.POWERUP_WIDTH;
    this.height = CONFIG.POWERUP_HEIGHT;
    this.type = type;
    this.alive = true;
    this.pulseTimer = 0;
    this.pulseSpeed = 0.1;
    this.pulseValue = 0;
    
    // Set properties based on type
    switch (type) {
      case 'R': // Rapid Fire
        this.color = '#ff6600';
        this.symbol = 'R';
        this.vy = 1.5;
        break;
      case 'S': // Shield Repair
        this.color = '#00ff00';
        this.symbol = 'S';
        this.vy = 1.5;
        break;
      case 'W': // Spread Shot
        this.color = '#00ffff';
        this.symbol = 'W';
        this.vy = 1.5;
        break;
      case 'L': // Extra Life
        this.color = '#ff00ff';
        this.symbol = 'L';
        this.vy = 1.5;
        break;
      default:
        this.color = CONFIG.POWERUP_COLOR;
        this.symbol = '?';
        this.vy = 1.5;
    }
  }

  update(deltaTime) {
    // Update position
    const timeScale = deltaTime / 16.67;
    this.y += this.vy * timeScale;
    
    // Pulse animation
    this.pulseTimer += deltaTime * this.pulseSpeed;
    this.pulseValue = Math.sin(this.pulseTimer) * 0.3 + 0.7;
    
    // Check if out of bounds (bottom of screen)
    if (this.y > CONFIG.CANVAS_HEIGHT + this.height) {
      this.alive = false;
    }
    
    return this.alive;
  }

  draw(ctx) {
    ctx.save();
    
    // Glow effect with pulse
    ctx.shadowBlur = 15 * this.pulseValue;
    ctx.shadowColor = this.color;
    
    // Draw power-up box
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = this.pulseValue;
    ctx.strokeRect(this.x - this.width / 2, this.y - this.height / 2, this.width, this.height);
    
    // Draw symbol
    ctx.fillStyle = this.color;
    ctx.font = `bold ${this.height * 0.6}px 'Courier New'`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.symbol, this.x, this.y);
    
    // Inner glow
    ctx.globalAlpha = this.pulseValue * 0.3;
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - this.width / 2, this.y - this.height / 2, this.width, this.height);
    
    ctx.restore();
  }

  getBounds() {
    return {
      x: this.x - this.width / 2,
      y: this.y - this.height / 2,
      width: this.width,
      height: this.height
    };
  }

  // Get effect duration in frames (at 60fps)
  getDuration() {
    return 480; // 8 seconds at 60fps
  }
}

export class PowerUpManager {
  constructor() {
    this.powerUps = [];
    this.maxPowerUps = 10;
    this.dropRate = 0.1; // 10% chance to drop
  }

  spawn(x, y) {
    if (this.powerUps.length >= this.maxPowerUps) return null;
    
    // Random type
    const types = ['R', 'S', 'W', 'L'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    const powerUp = new PowerUp(x, y, type);
    this.powerUps.push(powerUp);
    return powerUp;
  }

  update(deltaTime) {
    // Update all power-ups and remove dead ones
    this.powerUps = this.powerUps.filter(p => p.update(deltaTime));
  }

  draw(ctx) {
    for (const powerUp of this.powerUps) {
      powerUp.draw(ctx);
    }
  }

  // Check if player collected a power-up
  checkCollection(player) {
    const playerBounds = player.getBounds();
    
    for (let i = this.powerUps.length - 1; i >= 0; i--) {
      const powerUp = this.powerUps[i];
      const powerUpBounds = powerUp.getBounds();
      
      if (this.checkCollision(playerBounds, powerUpBounds)) {
        const collected = this.powerUps[i];
        this.powerUps.splice(i, 1);
        return collected;
      }
    }
    
    return null;
  }

  // Apply power-up effect to player
  applyToPlayer(player, powerUp) {
    const duration = powerUp.getDuration();
    
    switch (powerUp.type) {
      case 'R': // Rapid Fire
        player.activatePowerUp('rapid', duration);
        break;
      case 'S': // Shield Repair
        if (player.shield) {
          // Already has shield, extend duration
          player.shieldTimer = Math.max(player.shieldTimer, duration);
        } else {
          player.activatePowerUp('shield', duration);
        }
        break;
      case 'W': // Spread Shot
        player.activatePowerUp('spread', duration);
        break;
      case 'L': // Extra Life
        player.lives++;
        break;
    }
  }

  // Check collision between two rectangles
  checkCollision(rect1, rect2) {
    return (
      rect1.x < rect2.x + rect2.width &&
      rect1.x + rect1.width > rect2.x &&
      rect1.y < rect2.y + rect2.height &&
      rect1.y + rect1.height > rect2.y
    );
  }

  // Clear all power-ups
  clear() {
    this.powerUps = [];
  }

  // Set drop rate
  setDropRate(rate) {
    this.dropRate = Math.max(0, Math.min(1, rate));
  }
}

// Export for game.js
export const powerUps = new PowerUpManager();

export { PowerUp, PowerUpManager };
