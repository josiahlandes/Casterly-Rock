// Particle class for explosion effects
import { CONFIG } from './config.js';

export class Particle {
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.active = true;
    
    // Random velocity in all directions
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * CONFIG.PARTICLE_SPEED + 1;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    
    // Life and decay
    this.life = CONFIG.PARTICLE_LIFETIME;
    this.maxLife = CONFIG.PARTICLE_LIFETIME;
    this.size = Math.random() * 3 + 2;
  }

  update() {
    if (!this.active) return;

    // Update position
    this.x += this.vx;
    this.y += this.vy;
    
    // Apply gravity
    this.vy += CONFIG.PARTICLE_GRAVITY;
    
    // Decrease life
    this.life--;
    
    // Deactivate if dead or off screen
    if (this.life <= 0 || 
        this.x < 0 || this.x > CONFIG.CANVAS_WIDTH ||
        this.y < 0 || this.y > CONFIG.CANVAS_HEIGHT) {
      this.active = false;
    }
  }

  draw(ctx) {
    if (!this.active) return;

    ctx.save();
    
    // Calculate opacity based on life
    const opacity = this.life / this.maxLife;
    
    // Glow effect
    ctx.shadowBlur = 5;
    ctx.shadowColor = this.color;
    ctx.fillStyle = this.color;
    ctx.globalAlpha = opacity;

    // Draw particle as a small circle
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  isDead() {
    return !this.active;
  }
}
