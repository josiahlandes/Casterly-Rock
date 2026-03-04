// Player Ship Module

import { PLAYER, COLORS, SHADOW_BLUR, GLOW_OPACITY } from './config.js';
import { audio } from './audio.js';
import { particles } from './particles.js';

export class Player {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.width = PLAYER.WIDTH;
        this.height = PLAYER.HEIGHT;
        this.speed = PLAYER.SPEED;
        this.shield = PLAYER.SHIELD_MAX;
        this.maxShield = PLAYER.SHIELD_MAX;
        
        this.velocityX = 0;
        this.shootTimer = 0;
        this.shootCooldown = PLAYER.SHOOT_COOLDOWN;
        this.bulletsOnScreen = 0;
        this.maxBullets = PLAYER.MAX_BULLETS;
        
        // Power-up states
        this.rapidFire = false;
        this.rapidFireTimer = 0;
        this.spreadShot = false;
        this.spreadShotTimer = 0;
        
        // Animation
        this.animTimer = 0;
        this.glowPulse = 0;
    }
    
    update(dt, input) {
        this.animTimer += dt;
        this.glowPulse = Math.sin(this.animTimer * 5) * 0.1 + 1;
        
        // Movement with acceleration
        if (input.isLeft()) {
            this.velocityX -= this.speed * dt;
        }
        if (input.isRight()) {
            this.velocityX += this.speed * dt;
        }
        
        // Friction
        this.velocityX *= 0.92;
        
        // Update position
        this.x += this.velocityX * dt;
        
        // Boundary checks
        if (this.x < 0) {
            this.x = 0;
            this.velocityX = 0;
        }
        if (this.x + this.width > 800) {
            this.x = 800 - this.width;
            this.velocityX = 0;
        }
        
        // Update power-up timers
        if (this.rapidFire) {
            this.rapidFireTimer -= dt;
            if (this.rapidFireTimer <= 0) {
                this.rapidFire = false;
            }
        }
        if (this.spreadShot) {
            this.spreadShotTimer -= dt;
            if (this.spreadShotTimer <= 0) {
                this.spreadShot = false;
            }
        }
        
        // Shooting
        this.shootTimer -= dt;
        if (input.isShoot() && this.shootTimer <= 0 && this.bulletsOnScreen < this.maxBullets) {
            this.shoot();
        }
        
        // Thruster particles when moving
        if (Math.abs(this.velocityX) > 10) {
            this.emitThrusterParticles();
        }
    }
    
    shoot() {
        const cooldown = this.rapidFire ? this.shootCooldown / 2 : this.shootCooldown;
        this.shootTimer = cooldown;
        this.bulletsOnScreen++;
        
        if (this.spreadShot) {
            // Fire 3 bullets in a fan
            this.emitBullet(0);      // Center
            this.emitBullet(-0.15);  // Left
            this.emitBullet(0.15);   // Right
        } else {
            this.emitBullet(0);
        }
        
        audio.playPlayerShoot();
    }
    
    emitBullet(angle) {
        const bulletX = this.x + this.width / 2;
        const bulletY = this.y;
        return {
            x: bulletX,
            y: bulletY,
            width: PLAYER.WIDTH / 4,
            height: PLAYER.HEIGHT / 2,
            vx: Math.sin(angle) * 50,
            vy: -500,
            color: COLORS.PLAYER_BULLET,
            isPlayer: true
        };
    }
    
    emitThrusterParticles() {
        const centerX = this.x + this.width / 2;
        const bottomY = this.y + this.height;
        
        for (let i = 0; i < PLAYER.THRUSTER_PARTICLES; i++) {
            particles.emit(
                centerX + (Math.random() - 0.5) * 10,
                bottomY,
                (Math.random() - 0.5) * 30,
                50 + Math.random() * 50,
                0.3,
                COLORS.PARTICLE_TRAIL,
                2 + Math.random() * 2
            );
        }
    }
    
    hit() {
        if (this.shield > 0) {
            this.shield--;
            return true; // Hit absorbed
        }
        return false; // No shield left
    }
    
    repairShield() {
        if (this.shield < this.maxShield) {
            this.shield++;
            return true;
        }
        return false;
    }
    
    activateRapidFire() {
        this.rapidFire = true;
        this.rapidFireTimer = 8;
    }
    
    activateSpreadShot() {
        this.spreadShot = true;
        this.spreadShotTimer = 8;
    }
    
    reset() {
        this.shield = this.maxShield;
        this.rapidFire = false;
        this.spreadShot = false;
        this.velocityX = 0;
        this.shootTimer = 0;
        this.bulletsOnScreen = 0;
    }
    
    draw(ctx) {
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        
        // Glow effect
        ctx.save();
        ctx.shadowBlur = SHADOW_BLUR;
        ctx.shadowColor = COLORS.PLAYER;
        
        // Draw glow layer (larger, transparent)
        ctx.globalAlpha = GLOW_OPACITY * this.glowPulse;
        this.drawShip(ctx, centerX, centerY, 1.2);
        
        // Draw main ship
        ctx.globalAlpha = 1;
        this.drawShip(ctx, centerX, centerY, 1);
        
        ctx.restore();
    }
    
    drawShip(ctx, x, y, scale) {
        ctx.fillStyle = COLORS.PLAYER;
        
        // Main body - futuristic ship shape
        ctx.beginPath();
        ctx.moveTo(x, y - 15 * scale);  // Top point
        ctx.lineTo(x + 20 * scale, y + 10 * scale);  // Right wing
        ctx.lineTo(x + 10 * scale, y + 15 * scale);  // Right inner
        ctx.lineTo(x, y + 10 * scale);  // Bottom center
        ctx.lineTo(x - 10 * scale, y + 15 * scale);  // Left inner
        ctx.lineTo(x - 20 * scale, y + 10 * scale);  // Left wing
        ctx.closePath();
        ctx.fill();
        
        // Core (white center)
        ctx.fillStyle = COLORS.PLAYER_CORE;
        ctx.beginPath();
        ctx.arc(x, y - 5 * scale, 4 * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Wing highlights
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.beginPath();
        ctx.moveTo(x, y - 15 * scale);
        ctx.lineTo(x + 15 * scale, y + 5 * scale);
        ctx.lineTo(x, y + 8 * scale);
        ctx.lineTo(x - 15 * scale, y + 5 * scale);
        ctx.closePath();
        ctx.fill();
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

// Export for direct instantiation
export const playerFactory = (x, y) => new Player(x, y);