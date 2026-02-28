// Projectile class for Neon Invaders
import { CONFIG } from './config.js';

export class Projectile {
  constructor(x, y, isEnemy = false) {
    this.x = x;
    this.y = y;
    this.isEnemy = isEnemy;
    this.width = CONFIG.PROJECTILE_WIDTH;
    this.height = CONFIG.PROJECTILE_HEIGHT;
    this.active = true;
    
    // Set properties based on owner
    if (isEnemy) {
      this.speed = CONFIG.ENEMY_PROJECTILE_SPEED;
      this.color = CONFIG.ENEMY_PROJECTILE_COLOR;
    } else {
      this.speed = CONFIG.PLAYER_PROJECTILE_SPEED;
      this.color = CONFIG.PLAYER_PROJECTILE_COLOR;
    }
  }

  update() {
    if (!this.active) return;

    // Move projectile
    if (this.isEnemy) {
      this.y += this.speed; // Move down
    } else {
      this.y -= this.speed; // Move up
    }

    // Deactivate if off screen
    if (this.y < -this.height || this.y > CONFIG.CANVAS_HEIGHT) {
      this.active = false;
    }
  }

  draw(ctx) {
    if (!this.active) return;

    ctx.save();
    
    // Glow effect
    ctx.shadowBlur = 10;
    ctx.shadowColor = this.color;
    ctx.fillStyle = this.color;

    // Draw projectile as a glowing line
    ctx.fillRect(
      this.x,
      this.y,
      this.width,
      this.height
    );

    ctx.restore();
  }

  getBounds() {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height
    };
  }

  isOffScreen() {
    return this.y < -this.height || this.y > CONFIG.CANVAS_HEIGHT;
  }
}
