// Neon Invaders - Particle System
// Handles explosions, thruster trails, sparks, and power-up effects

import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, PARTICLE, GLOW } from './config.js';

export class Particle {
  constructor(x, y, vx, vy, life, maxLife, color, size) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.maxLife = maxLife;
    this.color = color;
    this.size = size;
    this.active = true;
  }

  update(dt) {
    // Update position
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    
    // Update life
    this.life -= dt;
    
    // Deactivate if life expired
    if (this.life <= 0) {
      this.active = false;
    }
  }

  getAlpha() {
    return this.life / this.maxLife;
  }

  getSize() {
    // Particles shrink as they fade
    return this.size * (this.life / this.maxLife);
  }
}

export class ParticleSystem {
  constructor() {
    this.particles = [];
    this.maxParticles = 500; // Limit for performance
  }

  // Add a single particle
  add(x, y, vx, vy, life, maxLife, color, size) {
    if (this.particles.length < this.maxParticles) {
      this.particles.push(new Particle(x, y, vx, vy, life, maxLife, color, size));
    }
  }

  // Create explosion at position
  createExplosion(x, y, color, count = null) {
    const countRange = count || PARTICLE.explosionCount;
    const numParticles = Math.floor(
      Math.random() * (countRange.max - countRange.min) + countRange.min
    );
    
    for (let i = 0; i < numParticles; i++) {
      const angle = (Math.PI * 2 * i) / numParticles + Math.random() * 0.5;
      const speed = Math.random() * (PARTICLE.explosionSpeed.max - PARTICLE.explosionSpeed.min) 
                    + PARTICLE.explosionSpeed.min;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      
      // Pick a color from explosion palette or use provided color
      const color = COLORS.explosion[Math.floor(Math.random() * COLORS.explosion.length)];
      const size = Math.random() * 3 + 2;
      
      this.add(x, y, vx, vy, PARTICLE.explosionLife, PARTICLE.explosionLife, color, size);
    }
  }

  // Create player thruster trail
  createThruster(x, y, movingLeft, movingRight) {
    if (!movingLeft && !movingRight) return;
    
    // Spawn 2-3 particles per frame when moving
    const numParticles = Math.floor(Math.random() * 2) + 2;
    
    for (let i = 0; i < numParticles; i++) {
      // Slight horizontal spread based on movement direction
      const spread = movingLeft ? -20 : movingRight ? 20 : 0;
      const vx = spread + (Math.random() - 0.5) * 30;
      const vy = PARTICLE.thrusterSpeed + Math.random() * 30;
      const size = Math.random() * 2 + 1;
      
      this.add(x + (Math.random() - 0.5) * 20, y, vx, vy, 
               PARTICLE.thrusterLife, PARTICLE.thrusterLife, COLORS.player, size);
    }
  }

  // Create bullet impact sparks
  createImpact(x, y, color) {
    const numParticles = PARTICLE.impactCount.min + Math.floor(Math.random() * 
                       (PARTICLE.impactCount.max - PARTICLE.impactCount.min));
    
    for (let i = 0; i < numParticles; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 100 + 50;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const size = Math.random() * 2 + 1;
      
      this.add(x, y, vx, vy, PARTICLE.impactLife, PARTICLE.impactLife, color, size);
    }
  }

  // Create power-up collect ring
  createPowerupCollect(x, y) {
    const numParticles = PARTICLE.powerupRingCount;
    
    for (let i = 0; i < numParticles; i++) {
      const angle = (Math.PI * 2 * i) / numParticles;
      const speed = 50;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const size = 2;
      
      this.add(x, y, vx, vy, PARTICLE.powerupRingLife, PARTICLE.powerupRingLife, 
               COLORS.powerup, size);
    }
  }

  // Update all particles
  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.update(dt);
      
      // Remove inactive particles
      if (!p.active) {
        this.particles.splice(i, 1);
      }
    }
  }

  // Draw all particles
  draw(ctx) {
    this.particles.forEach(p > {
      const alpha = p.getAlpha();
      const size = p.getSize();
      
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      
      // Draw particle as a small circle
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
      
      // Add glow effect
      ctx.shadowBlur = GLOW.mainShadowBlur;
      ctx.shadowColor = p.color;
      ctx.fill();
      
      ctx.restore();
    });
  }

  // Clear all particles
  clear() {
    this.particles = [];
  }

  // Get particle count
  getCount() {
    return this.particles.length;
  }
}

export default ParticleSystem;
