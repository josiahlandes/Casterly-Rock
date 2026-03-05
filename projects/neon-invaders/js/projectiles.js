// Projectiles - Player and enemy bullets
import { CONFIG } from './config.js';

export class Projectile {
    constructor(x, y, vx, vy, width, height, color, isPlayer) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.width = width;
        this.height = height;
        this.color = color;
        this.isPlayer = isPlayer;
        this.active = true;
    }
    
    update(dt) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        
        // Deactivate if off screen
        if (this.y < -50 || this.y > CONFIG.CANVAS_HEIGHT + 50 ||
            this.x < -50 || this.x > CONFIG.CANVAS_WIDTH + 50) {
            this.active = false;
        }
    }
    
    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height
        };
    }
    
    draw(ctx) {
        const alpha = 1;
        ctx.globalAlpha = alpha;
        
        // Glow effect
        ctx.shadowBlur = 10;
        ctx.shadowColor = this.color;
        
        // Main bullet
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x, this.y, this.width, this.height);
        
        // Core (brighter center)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(
            this.x + this.width * 0.25,
            this.y + this.height * 0.25,
            this.width * 0.5,
            this.height * 0.5
        );
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }
}

export class ProjectileManager {
    constructor() {
        this.projectiles = [];
    }
    
    add(projectile) {
        this.projectiles.push(projectile);
    }
    
    createPlayerBullet(x, y) {
        const bullet = new Projectile(
            x - CONFIG.PLAYER_BULLET_WIDTH / 2,
            y - CONFIG.PLAYER_BULLET_HEIGHT,
            0,
            -CONFIG.PLAYER_BULLET_SPEED,
            CONFIG.PLAYER_BULLET_WIDTH,
            CONFIG.PLAYER_BULLET_HEIGHT,
            CONFIG.COLORS.PLAYER,
            true
        );
        this.add(bullet);
        return bullet;
    }
    
    createEnemyBullet(x, y) {
        const bullet = new Projectile(
            x - CONFIG.ENEMY_BULLET_WIDTH / 2,
            y + CONFIG.ENEMY_HEIGHT,
            0,
            CONFIG.ENEMY_BULLET_SPEED,
            CONFIG.ENEMY_BULLET_WIDTH,
            CONFIG.ENEMY_BULLET_HEIGHT,
            CONFIG.COLORS.ENEMY_BULLET,
            false
        );
        this.add(bullet);
        return bullet;
    }
    
    createSpreadBullets(x, y, angleOffset = 0.2) {
        const bullets = [];
        const angles = [-angleOffset, 0, angleOffset];
        
        angles.forEach(angle => {
            const vx = Math.sin(angle) * CONFIG.PLAYER_BULLET_SPEED;
            const vy = -Math.cos(angle) * CONFIG.PLAYER_BULLET_SPEED;
            
            const bullet = new Projectile(
                x - CONFIG.PLAYER_BULLET_WIDTH / 2,
                y - CONFIG.PLAYER_BULLET_HEIGHT,
                vx,
                vy,
                CONFIG.PLAYER_BULLET_WIDTH,
                CONFIG.PLAYER_BULLET_HEIGHT,
                CONFIG.COLORS.PLAYER,
                true
            );
            this.add(bullet);
            bullets.push(bullet);
        });
        
        return bullets;
    }
    
    update(dt) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            this.projectiles[i].update(dt);
            if (!this.projectiles[i].active) {
                this.projectiles.splice(i, 1);
            }
        }
    }
    
    draw(ctx) {
        this.projectiles.forEach(p => p.draw(ctx));
    }
    
    getPlayerProjectiles() {
        return this.projectiles.filter(p => p.isPlayer);
    }
    
    getEnemyProjectiles() {
        return this.projectiles.filter(p => !p.isPlayer);
    }
    
    clear() {
        this.projectiles = [];
    }
}