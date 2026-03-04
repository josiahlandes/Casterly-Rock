// Particle System Module

import { PARTICLES, COLORS } from './config.js';

class ParticleSystem {
    constructor() {
        this.particles = [];
        this.pool = [];
        this.maxPoolSize = 500;
    }
    
    // Get a particle from pool or create new one
    getParticle() {
        if (this.pool.length > 0) {
            return this.pool.pop();
        }
        return {};
    }
    
    // Return particle to pool
    returnParticle(particle) {
        if (this.pool.length < this.maxPoolSize) {
            this.pool.push(particle);
        }
    }
    
    // Emit a single particle
    emit(x, y, vx, vy, life, color, size) {
        const p = this.getParticle();
        p.x = x;
        p.y = y;
        p.vx = vx;
        p.vy = vy;
        p.life = life;
        p.maxLife = life;
        p.color = color;
        p.size = size;
        this.particles.push(p);
    }
    
    // Create explosion at position
    createExplosion(x, y, color, count = PARTICLES.EXPLOSION_COUNT) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            this.emit(
                x,
                y,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                PARTICLES.EXPLOSION_LIFE,
                color,
                3 + Math.random() * 4
            );
        }
    }
    
    // Create bullet impact sparks
    createImpact(x, y, color, count = PARTICLES.IMPACT_COUNT) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 80;
            this.emit(
                x,
                y,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                PARTICLES.IMPACT_LIFE,
                color,
                2 + Math.random() * 2
            );
        }
    }
    
    // Create power-up collect effect
    createPowerUpCollect(x, y) {
        for (let i = 0; i < PARTICLES.POWERUP_COLLECT_COUNT; i++) {
            const angle = (i / PARTICLES.POWERUP_COLLECT_COUNT) * Math.PI * 2;
            const speed = 30 + Math.random() * 50;
            this.emit(
                x,
                y,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                PARTICLES.POWERUP_COLLECT_LIFE,
                COLORS.POWERUP,
                3 + Math.random() * 3
            );
        }
    }
    
    // Update all particles
    update(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            // Update position
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            
            // Update life
            p.life -= dt;
            
            // Remove dead particles
            if (p.life <= 0) {
                this.returnParticle(p);
                this.particles.splice(i, 1);
            }
        }
    }
    
    // Draw all particles
    draw(ctx) {
        for (const p of this.particles) {
            const lifeRatio = p.life / p.maxLife;
            const alpha = lifeRatio;
            const size = p.size * lifeRatio;
            
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.shadowBlur = 10;
            ctx.shadowColor = p.color;
            
            // Draw as a small circle
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        }
    }
    
    // Clear all particles
    clear() {
        for (const p of this.particles) {
            this.returnParticle(p);
        }
        this.particles = [];
    }
    
    // Get particle count
    getCount() {
        return this.particles.length;
    }
}

// Export singleton instance
export const particles = new ParticleSystem();