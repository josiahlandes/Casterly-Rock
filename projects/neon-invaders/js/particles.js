// Particles - Explosion, thruster trails, sparks
import { CONFIG } from './config.js';

export class Particle {
    constructor(x, y, vx, vy, color, size, life, maxLife) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.size = size;
        this.life = life;
        this.maxLife = maxLife;
    }
    
    update(dt) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.life -= dt;
        this.vy += 50 * dt; // slight gravity
    }
    
    isAlive() {
        return this.life > 0;
    }
    
    getAlpha() {
        return Math.max(0, this.life / this.maxLife);
    }
    
    getSize() {
        return this.size * this.getAlpha();
    }
}

export class ParticleSystem {
    constructor() {
        this.particles = [];
    }
    
    add(particle) {
        if (this.particles.length < CONFIG.MAX_PARTICLES) {
            this.particles.push(particle);
        }
    }
    
    createExplosion(x, y, color, count = CONFIG.EXPLOSION_PARTICLES) {
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
            const speed = 50 + Math.random() * 150;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            const size = 2 + Math.random() * 3;
            const life = 0.3 + Math.random() * 0.2;
            
            this.add(new Particle(x, y, vx, vy, color, size, life, life));
        }
    }
    
    createThruster(x, y) {
        const spread = 20;
        const vx = (Math.random() - 0.5) * spread;
        const vy = 50 + Math.random() * 50;
        const size = 1 + Math.random() * 2;
        const life = 0.2 + Math.random() * 0.1;
        
        this.add(new Particle(x, y, vx, vy, CONFIG.COLORS.PLAYER, size, life, life));
    }
    
    createImpact(x, y, color, count = CONFIG.IMPACT_PARTICLES) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 70;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            const size = 1 + Math.random() * 2;
            const life = 0.1 + Math.random() * 0.1;
            
            this.add(new Particle(x, y, vx, vy, color, size, life, life));
        }
    }
    
    createPowerupCollect(x, y) {
        for (let i = 0; i < CONFIG.POWERUP_PARTICLES; i++) {
            const angle = (Math.PI * 2 * i) / CONFIG.POWERUP_PARTICLES;
            const speed = 50 + Math.random() * 50;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            const size = 2 + Math.random() * 2;
            const life = 0.4 + Math.random() * 0.2;
            
            this.add(new Particle(x, y, vx, vy, CONFIG.COLORS.POWERUP, size, life, life));
        }
    }
    
    update(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            this.particles[i].update(dt);
            if (!this.particles[i].isAlive()) {
                this.particles.splice(i, 1);
            }
        }
    }
    
    draw(ctx) {
        this.particles.forEach(p => {
            const alpha = p.getAlpha();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.getSize(), 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    }
    
    clear() {
        this.particles = [];
    }
}