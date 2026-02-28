// Player class for Neon Invaders
import { CONFIG } from './config.js';

export class Player {
  constructor(canvasWidth, canvasHeight) {
    this.width = CONFIG.PLAYER_WIDTH;
    this.height = CONFIG.PLAYER_HEIGHT;
    this.x = canvasWidth / 2 - this.width / 2;
    this.y = canvasHeight - this.height - 20;
    this.speed = CONFIG.PLAYER_SPEED;
    this.color = CONFIG.PLAYER_COLOR;
    this.glow = CONFIG.PLAYER_GLOW;
    this.lives = CONFIG.INITIAL_LIVES;
    this.shield = false;
    this.shieldTimer = 0;
    this.spreadShot = false;
    this.spreadShotTimer = 0;
    this.rapidFire = false;
    this.rapidFireTimer = 0;
    this.lastShotTime = 0;
    this.shootDelay = 250; // ms between shots
  }

  update(input, canvasWidth, deltaTime) {
    // Horizontal movement with deltaTime for frame-rate independent physics
    const moveSpeed = this.speed * (deltaTime / 16.67); // Normalize to ~60fps
    
    if (input.keys['ArrowLeft'] || input.keys['a']) {
      this.x -= moveSpeed;
    }
    if (input.keys['ArrowRight'] || input.keys['d']) {
      this.x += moveSpeed;
    }

    // Clamp to canvas bounds
    this.x = Math.max(0, Math.min(canvasWidth - this.width, this.x));

    // Update power-up timers using deltaTime (convert ms to frames at 60fps)
    const deltaTimeFrames = deltaTime / 16.67;
    
    if (this.shield) {
      this.shieldTimer -= deltaTimeFrames;
      if (this.shieldTimer <= 0) {
        this.shield = false;
      }
    }

    if (this.spreadShot) {
      this.spreadShotTimer -= deltaTimeFrames;
      if (this.spreadShotTimer <= 0) {
        this.spreadShot = false;
      }
    }

    if (this.rapidFire) {
      this.rapidFireTimer -= deltaTimeFrames;
      if (this.rapidFireTimer <= 0) {
        this.rapidFire = false;
        this.shootDelay = 250;
      } else {
        this.shootDelay = 100;
      }
    }
  }

  shoot(currentTime) {
    if (currentTime - this.lastShotTime >= this.shootDelay) {
      this.lastShotTime = currentTime;
      
      if (this.spreadShot) {
        // Return 3 projectiles for spread shot
        return [
          { x: this.x + this.width / 2, y: this.y, vx: 0, vy: -CONFIG.PROJECTILE_SPEED },
          { x: this.x + this.width / 2, y: this.y, vx: -2, vy: -CONFIG.PROJECTILE_SPEED * 0.9 },
          { x: this.x + this.width / 2, y: this.y, vx: 2, vy: -CONFIG.PROJECTILE_SPEED * 0.9 }
        ];
      } else {
        // Return single projectile
        return [{ x: this.x + this.width / 2, y: this.y, vx: 0, vy: -CONFIG.PROJECTILE_SPEED }];
      }
    }
    return [];
  }

  activatePowerUp(type, duration = 600) {
    switch (type) {
      case 'spread':
        this.spreadShot = true;
        this.spreadShotTimer = duration;
        break;
      case 'rapid':
        this.rapidFire = true;
        this.rapidFireTimer = duration;
        break;
      case 'shield':
        this.shield = true;
        this.shieldTimer = duration;
        break;
      case 'life':
        this.lives++;
        break;
    }
  }

  takeDamage() {
    if (this.shield) {
      this.shield = false;
      return false; // Shield absorbed the damage
    }
    this.lives--;
    return true; // Player was actually damaged
  }

  // Check if shield is currently active
  isShieldActive() {
    return this.shield && this.shieldTimer > 0;
  }

  // Check if shield is depleted (not active)
  isShieldDepleted() {
    return !this.isShieldActive();
  }

  // Die method - called when player loses all lives
  die() {
    this.lives = 0;
    this.shield = false;
    this.spreadShot = false;
    this.rapidFire = false;
    return true;
  }

  // Check if player is still alive
  isAlive() {
    return this.lives > 0;
  }

  draw(ctx) {
    ctx.save();
    
    // Glow effect
    ctx.shadowBlur = this.glow;
    ctx.shadowColor = this.color;
    
    // Draw player ship (triangle shape)
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(this.x + this.width / 2, this.y);
    ctx.lineTo(this.x + this.width, this.y + this.height);
    ctx.lineTo(this.x + this.width / 2, this.y + this.height - 10);
    ctx.lineTo(this.x, this.y + this.height);
    ctx.closePath();
    ctx.fill();

    // Draw shield if active
    if (this.shield) {
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#00ff00';
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        this.x + this.width / 2,
        this.y + this.height / 2,
        this.width / 1.5,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }

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
}
