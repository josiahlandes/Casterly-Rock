// Power-ups - Drop system and effects
import { CONFIG } from './config.js';

export class PowerUp {
    constructor(x, y, type) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.width = CONFIG.POWERUP_WIDTH;
        this.height = CONFIG.POWERUP_HEIGHT;
        this.active = true;
        this.pulsePhase = 0;
        this.collectTime = 0;
        
        // Set display properties based on type
        switch(type) {
            case 'R':
                this.text = 'R';
                this.name = 'Rapid Fire';
                break;
            case 'S':
                this.text = 'S';
                this.name = 'Shield';
                break;
            case 'W':
                this.text = 'W';
                this.name = 'Spread';
                break;
        }
    }
    
    update(dt) {
        // Drift downward slowly
        this.y += CONFIG.POWERUP_SPEED * dt;
        
        // Update pulse animation
        this.pulsePhase += dt * CONFIG.POWERUP_PULSE_SPEED;
        
        // Deactivate if off screen
        if (this.y > CONFIG.CANVAS_HEIGHT + 50) {
            this.active = false;
        }
        
        if (this.collectTime > 0) {
            this.collectTime -= dt;
            if (this.collectTime <= 0) {
                this.active = false;
            }
        }
    }
    
    collect() {
        this.collectTime = 0.3;
        return true;
    }
    
    draw(ctx) {
        if (this.collectTime > 0) {
            // Shrink on collect
            const scale = this.collectTime / 0.3;
            const cx = this.x + this.width / 2;
            const cy = this.y + this.height / 2;
            
            ctx.globalAlpha = this.collectTime / 0.3;
            ctx.fillStyle = CONFIG.COLORS.POWERUP;
            ctx.beginPath();
            ctx.arc(cx, cy, this.width * scale / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            return;
        }
        
        const alpha = 0.8 + Math.sin(this.pulsePhase) * 0.2;
        const scale = 1 + Math.sin(this.pulsePhase * 2) * 0.1;
        
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 15;
        ctx.shadowColor = CONFIG.COLORS.POWERUP;
        
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        const w = this.width * scale;
        const h = this.height * scale;
        
        // Draw pulsing outline
        ctx.strokeStyle = CONFIG.COLORS.POWERUP;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(this.x + (this.width - w) / 2, this.y + (this.height - h) / 2, w, h);
        ctx.stroke();
        
        // Fill with semi-transparent
        ctx.fillStyle = `${CONFIG.COLORS.POWERUP}40`;
        ctx.fill();
        
        // Draw letter
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.text, cx, cy);
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
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

export class PowerUpManager {
    constructor() {
        this.powerups = [];
    }
    
    add(powerup) {
        this.powerups.push(powerup);
    }
    
    createDrop(x, y) {
        if (Math.random() < CONFIG.POWERUP_CHANCE) {
            const types = ['R', 'S', 'W'];
            const type = types[Math.floor(Math.random() * types.length)];
            const powerup = new PowerUp(
                x - CONFIG.POWERUP_WIDTH / 2,
                y,
                type
            );
            this.add(powerup);
            return powerup;
        }
        return null;
    }
    
    update(dt) {
        for (let i = this.powerups.length - 1; i >= 0; i--) {
            this.powerups[i].update(dt);
            if (!this.powerups[i].active) {
                this.powerups.splice(i, 1);
            }
        }
    }
    
    draw(ctx) {
        this.powerups.forEach(p => p.draw(ctx));
    }
    
    getActive() {
        return this.powerups.filter(p => p.active);
    }
    
    clear() {
        this.powerups = [];
    }
}