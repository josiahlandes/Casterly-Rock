// Neon Invaders - Projectiles
// Handles player and enemy bullets

import { CANVAS_WIDTH, CANVAS_HEIGHT, PROJECTILE, COLORS, GLOW } from './config.js';

export class Projectile {
  constructor(x, y, vx, vy, isPlayer, color) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.isPlayer = isPlayer;
    this.color = color;
    this.width = PROJECTILE.width;
    this.height = PROJECTILE.height;
    this.active = true;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    
    // Deactivate if off screen
    if (this.y < -this.height || this.y > CANVAS_HEIGHT + this.height ||
        this.x < -this.width || this.x > CANVAS_WIDTH + this.width) {
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
    ctx.save();
    
    // Draw glow effect
    ctx.shadowBlur = GLOW.glowShadowBlur;
    ctx.shadowColor = this.color;
    
    // Main bullet
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - this.width / 2, this.y - this.height / 2, 
                 this.width, this.height);
    
    // Inner bright core
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.x - this.width / 4, this.y - this.height / 4, 
                 this.width / 2, this.height / 2);
    
    ctx.restore();
  }
}

export class ProjectileManager {
  constructor() {
    this.projectiles = [];
    this.maxPlayerBullets = 3;
  }

  // Create a player bullet
  createPlayerBullet(x, y, angle = 0) {
    if (this.getPlayerCount() >= this.maxPlayerBullets) return null;
    
    const vx = Math.sin(angle) * PROJECTILE.playerSpeed;
    const vy = -Math.cos(angle) * PROJECTILE.playerSpeed;
    
    const bullet = new Projectile(x, y, vx, vy, true, COLORS.playerBullet);
    this.projectiles.push(bullet);
    return bullet;
  }

  // Create an enemy bullet
  createEnemyBullet(x, y) {
    // Enemy bullets fire straight down with slight random variation
    const vx = (Math.random() - 0.5) * 50;
    const vy = PROJECTILE.enemySpeed;
    
    const bullet = new Projectile(x, y, vx, vy, false, COLORS.enemyBullet);
    this.projectiles.push(bullet);
    return bullet;
  }

  // Get all player bullets
  getPlayerBullets() {
    return this.projectiles.filter(p > p.isPlayer);
  }

  // Get all enemy bullets
  getEnemyBullets() {
    return this.projectiles.filter(p > !p.isPlayer);
  }

  // Get count of player bullets
  getPlayerCount() {
    return this.getPlayerBullets().length;
  }

  // Update all projectiles
  update(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt);
      
      if (!p.active) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  // Draw all projectiles
  draw(ctx) {
    this.projectiles.forEach(p > p.draw(ctx));
  }

  // Clear all projectiles
  clear() {
    this.projectiles = [];
  }

  // Get all projectiles for collision checking
  getAll() {
    return this.projectiles;
  }

  // Set max player bullets (for power-ups)
  setMaxPlayerBullets(max) {
    this.maxPlayerBullets = max;
  }
}

export default ProjectileManager;
