// Neon Invaders - Player Ship
// Player movement, shooting, and shield management

import { CANVAS_WIDTH, CANVAS_HEIGHT, PLAYER, COLORS, GLOW } from './config.js';

export class Player {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = CANVAS_WIDTH / 2;
    this.y = CANVAS_HEIGHT - 80;
    this.vx = 0;
    this.shield = PLAYER.shieldMax;
    this.shieldMax = PLAYER.shieldMax;
    this.canShoot = true;
    this.shootCooldown = 0;
    this.active = true;
    this.invulnerable = 0; // Invulnerability time after hit
    this.movingLeft = false;
    this.movingRight = false;
  }

  update(dt, input, powerupManager) {
    // Update invulnerability timer
    if (this.invulnerable > 0) {
      this.invulnerable -= dt;
    }
    
    // Update shoot cooldown
    if (this.shootCooldown > 0) {
      this.shootCooldown -= dt * 1000; // Convert to ms
    }
    
    // Handle movement
    this.handleMovement(input, dt);
    
    // Handle shooting
    this.canShoot = this.shootCooldown <= 0;
  }

  handleMovement(input, dt) {
    const horizontal = input.getHorizontal();
    this.movingLeft = horizontal < 0;
    this.movingRight = horizontal > 0;
    
    if (horizontal !== 0) {
      // Accelerate
      this.vx += horizontal * PLAYER.speed * 5 * dt;
      
      // Clamp velocity
      this.vx = Math.max(-PLAYER.speed, Math.min(PLAYER.speed, this.vx));
    } else {
      // Decelerate (friction)
      this.vx *= 0.9;
      
      // Stop if very slow
      if (Math.abs(this.vx) < 10) {
        this.vx = 0;
      }
    }
    
    // Update position
    this.x += this.vx * dt;
    
    // Clamp to screen
    const halfWidth = PLAYER.width / 2;
    this.x = Math.max(halfWidth, Math.min(CANVAS_WIDTH - halfWidth, this.x));
  }

  tryShoot(powerupManager) {
    if (!this.canShoot || !this.active) return null;
    
    // Check bullet limit (unless rapid fire is active)
    const rapidFire = powerupManager && powerupManager.isEffectActive('rapid');
    const maxBullets = rapidFire ? 10 : PLAYER.maxBullets;
    
    // We need to check actual bullet count from the projectile manager
    // This will be handled by the caller
    
    // Calculate fire rate (doubled if rapid fire)
    const fireCooldown = rapidFire ? PLAYER.fireCooldown / 2 : PLAYER.fireCooldown;
    this.shootCooldown = fireCooldown;
    
    return true; // Signal that shooting is allowed
  }

  takeDamage() {
    if (this.invulnerable > 0 || !this.active) return false;
    
    if (this.shield > 0) {
      this.shield--;
      this.invulnerable = 1.5; // 1.5 seconds invulnerability
      
      if (this.shield <= 0) {
        this.active = false;
      }
      return true;
    }
    
    return false;
  }

  restoreShield() {
    if (this.shield < this.shieldMax) {
      this.shield++;
      return true;
    }
    return false;
  }

  getBounds() {
    return {
      x: this.x - PLAYER.width / 2,
      y: this.y - PLAYER.height / 2,
      width: PLAYER.width,
      height: PLAYER.height
    };
  }

  draw(ctx) {
    if (!this.active) return;
    
    // Flash if invulnerable
    if (this.invulnerable > 0 && Math.floor(Date.now() / 100) % 2 === 0) {
      return;
    }
    
    ctx.save();
    ctx.translate(this.x, this.y);
    
    // Draw glow effect
    ctx.shadowBlur = GLOW.glowShadowBlur;
    ctx.shadowColor = COLORS.player;
    
    // Draw ship body
    ctx.fillStyle = COLORS.player;
    
    // Main ship shape (triangular fighter)
    ctx.beginPath();
    ctx.moveTo(0, -PLAYER.height / 2); // Nose
    ctx.lineTo(PLAYER.width / 2, PLAYER.height / 2); // Right wing
    ctx.lineTo(0, PLAYER.height / 3); // Center indent
    ctx.lineTo(-PLAYER.width / 2, PLAYER.height / 2); // Left wing
    ctx.closePath();
    ctx.fill();
    
    // Draw core
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.playerCore;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw cockpit
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(0, -5, 4, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
  }

  // Get shield percentage (0-1)
  getShieldPercent() {
    return this.shield / this.shieldMax;
  }
}

export default Player;
