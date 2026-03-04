// Projectiles Module (Player bullets and enemy missiles)

import { PROJECTILE, COLORS, SHADOW_BLUR, GLOW_OPACITY } from './config.js';
import { audio } from './audio.js';
import { particles } from './particles.js';

export class ProjectileManager {
    constructor() {
        this.projectiles = [];
    }
    
    // Add a projectile
    add(projectile) {
        this.projectiles.push({
            x: projectile.x,
            y: projectile.y,
            width: projectile.width || PROJECTILE.PLAYER_WIDTH,
            height: projectile.height || PROJECTILE.PLAYER_HEIGHT,
            vx: projectile.vx || 0,
            vy: projectile.vy || PROJECTILE.PLAYER_SPEED,
            color: projectile.color || COLORS.PLAYER_BULLET,
            isPlayer: projectile.isPlayer || false
        });
    }
    
    // Update all projectiles
    update(dt) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            
            // Update position
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            
            // Remove if off screen
            if (p.y < -50 || p.y > 650) {
                this.projectiles.splice(i, 1);
            }
        }
    }
    
    // Draw all projectiles with glow effect
    draw(ctx) {
        for (const p of this.projectiles) {
            ctx.save();
            ctx.shadowBlur = SHADOW_BLUR;
            ctx.shadowColor = p.color;
            
            // Draw glow layer
            ctx.globalAlpha = GLOW_OPACITY;
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - 2, p.y - 2, p.width + 4, p.height + 4);
            
            // Draw main projectile
            ctx.globalAlpha = 1;
            ctx.fillStyle = p.color;
            
            if (p.isPlayer) {
                // Player bullet - elongated bolt
                ctx.fillRect(p.x, p.y, p.width, p.height);
                
                // White core
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(p.x + 1, p.y + 2, p.width - 2, p.height - 4);
            } else {
                // Enemy bullet - slightly different shape
                ctx.beginPath();
                ctx.ellipse(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, p.height / 2, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            
            ctx.restore();
        }
    }
    
    // Get all projectiles for collision detection
    getAll() {
        return this.projectiles;
    }
    
    // Clear all projectiles
    clear() {
        this.projectiles = [];
    }
    
    // Handle bullet leaving screen (called from main)
    onBulletLeave(bullet) {
        // Decrement player's bullet counter if it's a player bullet
        if (bullet.isPlayer && bullet.owner) {
            bullet.owner.bulletsOnScreen = Math.max(0, bullet.owner.bulletsOnScreen - 1);
        }
    }
}

// Export singleton
export const projectiles = new ProjectileManager();