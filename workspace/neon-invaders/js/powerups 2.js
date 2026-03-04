// Power-up Module

import { POWERUP, COLORS, SHADOW_BLUR, GLOW_OPACITY } from './config.js';
import { audio } from './audio.js';
import { particles } from './particles.js';

export class PowerUpManager {
    constructor() {
        this.powerUps = [];
    }
    
    // Chance to drop a power-up when enemy is destroyed
    maybeDrop(x, y) {
        if (Math.random() > POWERUP.CHANCE) return null;
        
        const types = Object.values(POWERUP.TYPES);
        const type = types[Math.floor(Math.random() * types.length)];
        
        return {
            x: x - POWERUP.WIDTH / 2,
            y: y - POWERUP.HEIGHT / 2,
            width: POWERUP.WIDTH,
            height: POWERUP.HEIGHT,
            type: type,
            life: 10, // seconds before despawn
            pulseTimer: 0
        };
    }
    
    // Add a power-up
    add(powerUp) {
        if (powerUp) {
            this.powerUps.push(powerUp);
        }
    }
    
    // Update all power-ups
    update(dt) {
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const p = this.powerUps[i];
            
            // Drift downward
            p.y += POWERUP.DROP_SPEED * dt;
            
            // Update timers
            p.life -= dt;
            p.pulseTimer += dt * 3;
            
            // Remove if off screen or expired
            if (p.y > POWERUP.DESPAWN_Y || p.life <= 0) {
                this.powerUps.splice(i, 1);
            }
        }
    }
    
    // Check collision with player
    checkCollision(player) {
        const playerBounds = player.getBounds();
        
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const p = this.powerUps[i];
            
            if (this.rectIntersect(playerBounds, p)) {
                // Apply power-up effect
                this.applyEffect(player, p.type);
                
                // Create collect particles
                particles.createPowerUpCollect(
                    p.x + p.width / 2,
                    p.y + p.height / 2
                );
                
                // Play sound
                audio.playPowerUpCollect();
                
                // Remove power-up
                this.powerUps.splice(i, 1);
                
                return true;
            }
        }
        
        return false;
    }
    
    // Apply power-up effect to player
    applyEffect(player, type) {
        switch (type) {
            case POWERUP.TYPES.RAPID_FIRE:
                player.activateRapidFire();
                break;
            case POWERUP.TYPES.SHIELD_REPAIR:
                player.repairShield();
                break;
            case POWERUP.TYPES.SPREAD_SHOT:
                player.activateSpreadShot();
                break;
        }
    }
    
    // Draw all power-ups with pulsing glow
    draw(ctx) {
        for (const p of this.powerUps) {
            const centerX = p.x + p.width / 2;
            const centerY = p.y + p.height / 2;
            const pulse = Math.sin(p.pulseTimer) * 0.3 + 0.7;
            
            ctx.save();
            ctx.shadowBlur = SHADOW_BLUR * pulse;
            ctx.shadowColor = COLORS.POWERUP;
            
            // Draw glow layer
            ctx.globalAlpha = GLOW_OPACITY * pulse;
            ctx.fillStyle = COLORS.POWERUP;
            ctx.beginPath();
            ctx.arc(centerX, centerY, 20, 0, Math.PI * 2);
            ctx.fill();
            
            // Draw main power-up box
            ctx.globalAlpha = 1;
            ctx.strokeStyle = COLORS.POWERUP;
            ctx.lineWidth = 2;
            ctx.strokeRect(p.x, p.y, p.width, p.height);
            
            // Fill with semi-transparent gold
            ctx.fillStyle = 'rgba(255, 215, 0, 0.2)';
            ctx.fillRect(p.x, p.y, p.width, p.height);
            
            // Draw letter
            ctx.fillStyle = COLORS.POWERUP;
            ctx.font = 'bold 18px Courier New';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.type, centerX, centerY);
            
            ctx.restore();
        }
    }
    
    // Rectangle intersection helper
    rectIntersect(a, b) {
        return a.x < b.x + b.width &&
               a.x + a.width > b.x &&
               a.y < b.y + b.height &&
               a.y + a.height > b.y;
    }
    
    // Clear all power-ups
    clear() {
        this.powerUps = [];
    }
}

// Export singleton
export const powerUps = new PowerUpManager();