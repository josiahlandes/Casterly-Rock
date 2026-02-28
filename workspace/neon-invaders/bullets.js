// Projectile/Bullet system for Neon Invaders
import { CONFIG } from './config.js';

export class Bullet {
  constructor(x, y, vx, vy, isPlayer = true, color = null) {
    this.x = x;
    this.y = y;
    this.width = CONFIG.PROJECTILE_WIDTH;
    this.height = CONFIG.PROJECTILE_HEIGHT;
    this.vx = vx;
    this.vy = vy;
    this.isPlayer = isPlayer;
    this.color = color || (isPlayer ? CONFIG.PROJECTILE_COLOR : '#ff3333');
    this.alive = true;
    this.trailTimer = 0;
  }

  update(deltaTime) {
    // Update position with deltaTime for frame-rate independent movement
    const timeScale = deltaTime / 16.67; // Normalize to ~60fps
    
    this.x += this.vx * timeScale;
    this.y += this.vy * timeScale;
    
    // Trail effect timer
    this.trailTimer += deltaTime;
    
    // Check if out of bounds
    if (this.y < -this.height || this.y > CONFIG.CANVAS_HEIGHT + this.height ||
        this.x < -this.width || this.x > CONFIG.CANVAS_WIDTH + this.width) {
      this.alive = false;
    }
    
    return this.alive;
  }

  draw(ctx) {
    ctx.save();
    
    // Glow effect
    ctx.shadowBlur = 10;
    ctx.shadowColor = this.color;
    
    // Draw bullet
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - this.width / 2, this.y, this.width, this.height);
    
    // Draw trail if moving fast
    if (Math.abs(this.vy) > 5 || Math.abs(this.vx) > 2) {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(
        this.x - this.width / 2,
        this.y + this.height,
        this.width,
        this.height * 0.5
      );
    }
    
    ctx.restore();
  }

  getBounds() {
    return {
      x: this.x - this.width / 2,
      y: this.y,
      width: this.width,
      height: this.height
    };
  }
}

export class BulletManager {
  constructor() {
    this.bullets = [];
    this.maxBullets = 100;
    this.playerBulletLimit = 3;
  }

  spawn(x, y, vx, vy, isPlayer = true, color = null) {
    // Check player bullet limit
    if (isPlayer) {
      const playerBullets = this.bullets.filter(b => b.isPlayer).length;
      if (playerBullets >= this.playerBulletLimit) {
        return null;
      }
    }
    
    if (this.bullets.length < this.maxBullets) {
      const bullet = new Bullet(x, y, vx, vy, isPlayer, color);
      this.bullets.push(bullet);
      return bullet;
    }
    return null;
  }

  update(deltaTime) {
    // Update all bullets and remove dead ones
    this.bullets = this.bullets.filter(bullet => bullet.update(deltaTime));
  }

  draw(ctx) {
    for (const bullet of this.bullets) {
      bullet.draw(ctx);
    }
  }

  // Get player bullets
  getPlayerBullets() {
    return this.bullets.filter(b => b.isPlayer);
  }

  // Get enemy bullets
  getEnemyBullets() {
    return this.bullets.filter(b => !b.isPlayer);
  }

  // Clear all bullets
  clear() {
    this.bullets = [];
  }

  // Remove specific bullet
  remove(bullet) {
    const index = this.bullets.indexOf(bullet);
    if (index > -1) {
      this.bullets.splice(index, 1);
    }
  }

  // Check if player can shoot
  canShoot() {
    return this.getPlayerBullets().length < this.playerBulletLimit;
  }
}

// Export for game.js
export const bullets = new BulletManager();

export { Bullet, BulletManager };
