// Player - Player ship with movement, shooting, and shield
import { CONFIG } from './config.js';

export class Player {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.shield = CONFIG.SHIELD_MAX;
        this.shieldFlashTime = 0;
        this.shootCooldown = 0;
        this.width = CONFIG.PLAYER_WIDTH;
        this.height = CONFIG.PLAYER_HEIGHT;
        
        // Power-up states
        this.rapidFireTime = 0;
        this.spreadShotTime = 0;
    }
    
    reset() {
        this.x = CONFIG.CANVAS_WIDTH / 2 - this.width / 2;
        this.y = CONFIG.CANVAS_HEIGHT - 60;
        this.vx = 0;
        this.shield = CONFIG.SHIELD_MAX;
        this.shieldFlashTime = 0;
        this.shootCooldown = 0;
        this.rapidFireTime = 0;
        this.spreadShotTime = 0;
    }
    
    update(dt, input) {
        // Horizontal movement with acceleration
        if (input.isLeft()) {
            this.vx -= CONFIG.PLAYER_SPEED_ACCEL * dt;
        } else if (input.isRight()) {
            this.vx += CONFIG.PLAYER_SPEED_ACCEL * dt;
        } else {
            // Deceleration
            if (this.vx > 0) {
                this.vx -= CONFIG.PLAYER_SPEED_DECEL * dt;
                if (this.vx < 0) this.vx = 0;
            } else if (this.vx < 0) {
                this.vx += CONFIG.PLAYER_SPEED_DECEL * dt;
                if (this.vx > 0) this.vx = 0;
            }
        }
        
        // Clamp velocity
        this.vx = Math.max(-CONFIG.PLAYER_SPEED, Math.min(CONFIG.PLAYER_SPEED, this.vx));
        
        // Update position
        this.x += this.vx * dt;
        
        // Clamp to screen
        this.x = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - this.width, this.x));
        
        // Update timers
        if (this.shieldFlashTime > 0) {
            this.shieldFlashTime -= dt;
        }
        if (this.shootCooldown > 0) {
            this.shootCooldown -= dt;
        }
        if (this.rapidFireTime > 0) {
            this.rapidFireTime -= dt;
        }
        if (this.spreadShotTime > 0) {
            this.spreadShotTime -= dt;
        }
    }
    
    shoot() {
        const cooldown = this.rapidFireTime > 0 ? CONFIG.SHOOT_COOLDOWN / 2 : CONFIG.SHOOT_COOLDOWN;
        if (this.shootCooldown <= 0) {
            this.shootCooldown = cooldown;
            return true;
        }
        return false;
    }
    
    getShootCooldown() {
        return this.rapidFireTime > 0 ? CONFIG.SHOOT_COOLDOWN / 2 : CONFIG.SHOOT_COOLDOWN;
    }
    
    hit() {
        if (this.shieldFlashTime > 0) return false; // Invulnerable
        
        this.shield--;
        this.shieldFlashTime = CONFIG.SHIELD_FLASH_TIME;
        return this.shield <= 0;
    }
    
    addShield() {
        if (this.shield < CONFIG.SHIELD_MAX) {
            this.shield++;
            return true;
        }
        return false;
    }
    
    activateRapidFire() {
        this.rapidFireTime = CONFIG.POWERUP_DURATION;
    }
    
    activateSpreadShot() {
        this.spreadShotTime = CONFIG.POWERUP_DURATION;
    }
    
    hasRapidFire() {
        return this.rapidFireTime > 0;
    }
    
    hasSpreadShot() {
        return this.spreadShotTime > 0;
    }
    
    isInvulnerable() {
        return this.shieldFlashTime > 0;
    }
    
    draw(ctx) {
        const alpha = this.isInvulnerable() ? (Math.sin(Date.now() / 50) > 0 ? 0.5 : 1) : 1;
        
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 20;
        ctx.shadowColor = CONFIG.COLORS.PLAYER;
        
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        
        // Draw ship
        ctx.fillStyle = CONFIG.COLORS.PLAYER;
        ctx.beginPath();
        
        // Main body (triangle pointing up)
        ctx.moveTo(cx, this.y);
        ctx.lineTo(this.x + this.width, this.y + this.height);
        ctx.lineTo(cx, this.y + this.height - 8);
        ctx.lineTo(this.x, this.y + this.height);
        ctx.closePath();
        ctx.fill();
        
        // Core (white center)
        ctx.fillStyle = CONFIG.COLORS.PLAYER_CORE;
        ctx.beginPath();
        ctx.moveTo(cx, this.y + 5);
        ctx.lineTo(cx + 5, this.y + this.height - 5);
        ctx.lineTo(cx - 5, this.y + this.height - 5);
        ctx.closePath();
        ctx.fill();
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }
    
    getBounds() {
        return {
            x: this.x + 5,
            y: this.y + 5,
            width: this.width - 10,
            height: this.height - 10
        };
    }
}