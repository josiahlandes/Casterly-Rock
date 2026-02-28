// Particle system for visual effects
export class Particle {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.life = 1.0;
    this.decay = 0.02 + Math.random() * 0.03;
    
    switch (type) {
      case 'explosion':
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 4;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.size = 3 + Math.random() * 4;
        this.color = `hsl(${30 + Math.random() * 30}, 100%, 60%)`;
        break;
        
      case 'spark':
        const sparkAngle = Math.random() * Math.PI * 2;
        const sparkSpeed = 3 + Math.random() * 6;
        this.vx = Math.cos(sparkAngle) * sparkSpeed;
        this.vy = Math.sin(sparkAngle) * sparkSpeed;
        this.size = 1 + Math.random() * 2;
        this.color = `hsl(${50 + Math.random() * 40}, 100%, 70%)`;
        this.decay = 0.04 + Math.random() * 0.02;
        break;
        
      case 'trail':
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = Math.random() * 0.5 + 0.5;
        this.size = 2 + Math.random() * 2;
        this.color = `hsla(180, 100%, 60%, 0.5)`;
        this.decay = 0.03;
        break;
        
      case 'powerup':
        const puAngle = Math.random() * Math.PI * 2;
        const puSpeed = 1 + Math.random() * 2;
        this.vx = Math.cos(puAngle) * puSpeed;
        this.vy = Math.sin(puAngle) * puSpeed;
        this.size = 2 + Math.random() * 2;
        this.color = `hsl(${Math.random() * 360}, 100%, 70%)`;
        this.decay = 0.015;
        break;
        
      case 'text':
        this.vx = 0;
        this.vy = -1 - Math.random();
        this.size = 12 + Math.random() * 4;
        this.color = '#fff';
        this.decay = 0.01;
        this.text = type;
        break;
        
      default:
        this.vx = 0;
        this.vy = 0;
        this.size = 2;
        this.color = '#fff';
    }
  }
  
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
    
    // Add some randomness to movement
    this.vx += (Math.random() - 0.5) * 0.1;
    this.vy += (Math.random() - 0.5) * 0.1;
    
    // Dampen velocity
    this.vx *= 0.98;
    this.vy *= 0.98;
    
    return this.life > 0;
  }
  
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.life;
    
    if (this.type === 'text') {
      ctx.font = `bold ${this.size}px 'Courier New'`;
      ctx.fillStyle = this.color;
      ctx.fillText(this.text, this.x, this.y);
    } else {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      
      // Add glow effect
      ctx.shadowBlur = 10;
      ctx.shadowColor = this.color;
      ctx.fill();
    }
    
    ctx.restore();
  }
}

export class ParticleSystem {
  constructor() {
    this.particles = [];
    this.maxParticles = 500;
  }
  
  emit(x, y, type, count = 10) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length < this.maxParticles) {
        this.particles.push(new Particle(x, y, type));
      }
    }
  }
  
  update() {
    this.particles = this.particles.filter(p => p.update());
  }
  
  draw(ctx) {
    this.particles.forEach(p => p.draw(ctx));
  }
  
  clear() {
    this.particles = [];
  }
  
  // Create explosion effect
  createExplosion(x, y, size = 'medium') {
    const count = size === 'large' ? 30 : size === 'small' ? 10 : 20;
    this.emit(x, y, 'explosion', count);
    this.emit(x, y, 'spark', count / 2);
  }
  
  // Create trail effect (for player/enemy movement)
  createTrail(x, y, color = null) {
    if (color) {
      // Custom colored trail
      const particle = new Particle(x, y, 'trail');
      particle.color = color;
      this.particles.push(particle);
    } else {
      this.emit(x, y, 'trail', 1);
    }
  }
  
  // Create power-up effect
  createPowerupEffect(x, y) {
    this.emit(x, y, 'powerup', 15);
  }
  
  // Create score text effect
  createScoreText(x, y, score) {
    const particle = new Particle(x, y, 'text');
    particle.text = `+${score}`;
    this.particles.push(particle);
  }
  
  // Create screen shake particles
  createShakeEffect() {
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      this.emit(x, y, 'spark', 1);
    }
  }
}

export const particles = new ParticleSystem();
