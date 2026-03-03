// Particle System for explosions, trails, and effects
export default class ParticleSystem {
    constructor() {
        this.particles = [];
        this.maxParticles = 500;
    }
    
    update(dt) {
        const dtSeconds = dt / 1000;
        
        // Update all particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            // Update position
            p.x += p.vx * dtSeconds;
            p.y += p.vy * dtSeconds;
            
            // Update life
            p.life -= dt;
            
            // Apply gravity to some particles
            if (p.gravity) {
                p.vy += p.gravity * dtSeconds;
            }
            
            // Remove dead particles
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }
    
    draw(ctx) {
        this.particles.forEach(p => {
            const alpha = p.life / p.maxLife;
            
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            
            // Glow effect for some particles
            if (p.glow) {
                ctx.shadowBlur = 10;
                ctx.shadowColor = p.color;
            }
            
            // Draw particle
            const size = p.size * alpha;
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        });
    }
    
    // Explosion burst
    createExplosion(x, y, color, count = 20) {
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
            const speed = 50 + Math.random() * 150;
            
            this.particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 500,
                maxLife: 500,
                color: color,
                size: 2 + Math.random() * 2,
                gravity: 100
            });
        }
    }
    
    // Player thruster trail
    createThruster(x, y) {
        const spread = (Math.random() - 0.5) * 30;
        
        this.particles.push({
            x: x + spread,
            y: y + 15,
            vx: (Math.random() - 0.5) * 20,
            vy: 50 + Math.random() * 50,
            life: 300,
            maxLife: 300,
            color: '#00fff5',
            size: 1 + Math.random() * 1.5,
            glow: true
        });
    }
    
    // Bullet impact sparks
    createImpact(x, y, color, count = 6) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 100 + Math.random() * 100;
            
            this.particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 200,
                maxLife: 200,
                color: color,
                size: 1 + Math.random() * 1,
                gravity: 200
            });
        }
    }
    
    // Power-up collect effect
    createPowerUpCollect(x, y) {
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 * i) / 12;
            const speed = 80;
            
            this.particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 400,
                maxLife: 400,
                color: '#ffd700',
                size: 2,
                glow: true
            });
        }
    }
    
    // Clear all particles
    clear() {
        this.particles = [];
    }
}
