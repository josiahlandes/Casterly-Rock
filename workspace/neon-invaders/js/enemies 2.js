// Enemy System Module

import { ENEMY, ENEMY_TYPES, COLORS, SHADOW_BLUR, GLOW_OPACITY } from './config.js';
import { audio } from './audio.js';
import { particles } from './particles.js';

export class EnemyGrid {
    constructor(level) {
        this.enemies = [];
        this.gridOffsetX = 0;
        this.gridOffsetY = 0;
        this.direction = 1; // 1 = right, -1 = left
        this.moveSpeed = ENEMY.MOVE_SPEED_BASE;
        this.fireRate = ENEMY.FIRE_RATE_BASE;
        this.level = level;
        this.aliveCount = 0;
        
        this.initGrid(level);
    }
    
    initGrid(level) {
        this.enemies = [];
        this.gridOffsetY = ENEMY.GRID_START_Y + (level - 1) * ENEMY.START_Y_INCREMENT;
        
        // Calculate starting X to center the grid
        const totalWidth = ENEMY.GRID_COLS * (ENEMY.WIDTH + ENEMY.GRID_PADDING_X) - ENEMY.GRID_PADDING_X;
        const startX = (800 - totalWidth) / 2;
        
        for (let row = 0; row < ENEMY.GRID_ROWS; row++) {
            for (let col = 0; col < ENEMY.GRID_COLS; col++) {
                const enemyType = this.getEnemyType(row, level);
                const x = startX + col * (ENEMY.WIDTH + ENEMY.GRID_PADDING_X);
                const y = this.gridOffsetY + row * (ENEMY.HEIGHT + ENEMY.GRID_PADDING_Y);
                
                this.enemies.push({
                    x: x,
                    y: y,
                    width: ENEMY.WIDTH,
                    height: ENEMY.HEIGHT,
                    type: enemyType,
                    hp: enemyType.hp,
                    maxHp: enemyType.hp,
                    points: enemyType.points,
                    speed: enemyType.speed,
                    color: enemyType.color,
                    shape: enemyType.shape,
                    hitFlashTimer: 0,
                    animTimer: Math.random() * Math.PI * 2,
                    alive: true
                });
            }
        }
        
        this.aliveCount = this.enemies.length;
        this.updateFireRate();
    }
    
    getEnemyType(row, level) {
        // Back rows are stronger enemies
        if (level >= 3 && row === 0) {
            // Front row: Type C (Scout)
            return ENEMY_TYPES.C;
        } else if (level >= 2 && row >= ENEMY.GRID_ROWS - 2) {
            // Back rows: Type B (Tank)
            return ENEMY_TYPES.B;
        } else {
            // Default: Type A (Drone)
            return ENEMY_TYPES.A;
        }
    }
    
    updateFireRate() {
        let rate = this.fireRate + this.level * ENEMY.FIRE_RATE_LEVEL_BOOST;
        
        // Every 5 levels, 50% more fire rate
        if (this.level % 5 === 0) {
            rate *= (1 + ENEMY.FIRE_RATE_BOOST_EVERY_5);
        }
        
        this.fireRate = rate;
    }
    
    update(dt) {
        // Update animation timers
        for (const enemy of this.enemies) {
            if (enemy.alive) {
                enemy.animTimer += dt * 2;
                if (enemy.hitFlashTimer > 0) {
                    enemy.hitFlashTimer -= dt;
                }
            }
        }
        
        // Calculate effective speed (faster as enemies die)
        const aliveRatio = this.aliveCount / this.enemies.length;
        const effectiveSpeed = this.moveSpeed + (1 - aliveRatio) * (ENEMY.MOVE_SPEED_MAX - this.moveSpeed);
        
        // Move grid horizontally
        this.gridOffsetX += effectiveSpeed * dt * this.direction;
        
        // Check if any enemy hit the edge
        let hitEdge = false;
        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            
            const enemyX = enemy.x + this.gridOffsetX;
            if (enemyX <= 0 || enemyX + enemy.width >= 800) {
                hitEdge = true;
                break;
            }
        }
        
        // If hit edge, shift down and reverse direction
        if (hitEdge) {
            this.gridOffsetX = 0;
            this.gridOffsetY += ENEMY.DROP_DISTANCE;
            this.direction *= -1;
        }
        
        // Random enemy fire
        if (Math.random() < this.fireRate * this.aliveCount) {
            this.fireRandomBullet();
        }
    }
    
    fireRandomBullet() {
        const aliveEnemies = this.enemies.filter(e => e.alive);
        if (aliveEnemies.length === 0) return;
        
        const shooter = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
        const bulletX = shooter.x + shooter.width / 2 + this.gridOffsetX;
        const bulletY = shooter.y + shooter.height;
        
        return {
            x: bulletX,
            y: bulletY,
            width: ENEMY.WIDTH / 5,
            height: ENEMY.HEIGHT / 3,
            vy: ENEMY.FIRE_SPEED || 200,
            color: COLORS.ENEMY_BULLET,
            isPlayer: false
        };
    }
    
    hit(enemy, damage = 1) {
        if (!enemy.alive) return null;
        
        enemy.hp -= damage;
        enemy.hitFlashTimer = 0.1;
        
        // Create impact particles
        const enemyX = enemy.x + enemy.width / 2 + this.gridOffsetX;
        particles.createImpact(enemyX, enemy.y + enemy.height / 2, enemy.color);
        
        if (enemy.hp <= 0) {
            enemy.alive = false;
            this.aliveCount--;
            
            // Create explosion
            particles.createExplosion(
                enemy.x + enemy.width / 2 + this.gridOffsetX,
                enemy.y + enemy.height / 2,
                enemy.color
            );
            
            audio.playEnemyDestroyed();
            
            return {
                points: enemy.points,
                x: enemy.x + enemy.width / 2 + this.gridOffsetX,
                y: enemy.y + enemy.height / 2
            };
        }
        
        return null;
    }
    
    getBounds() {
        let minX = 800, maxX = 0, maxY = 0;
        
        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            
            const enemyX = enemy.x + this.gridOffsetX;
            minX = Math.min(minX, enemyX);
            maxX = Math.max(maxX, enemyX + enemy.width);
            maxY = Math.max(maxY, enemy.y + enemy.height);
        }
        
        return { x: minX, y: 0, width: maxX - minX, height: maxY };
    }
    
    getLowestY() {
        let lowestY = 0;
        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            lowestY = Math.max(lowestY, enemy.y + enemy.height);
        }
        return lowestY;
    }
    
    draw(ctx) {
        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            
            const x = enemy.x + this.gridOffsetX;
            const y = enemy.y;
            const centerX = x + enemy.width / 2;
            const centerY = y + enemy.height / 2;
            
            // Determine color (flash white if recently hit)
            let drawColor = enemy.color;
            if (enemy.hitFlashTimer > 0) {
                drawColor = COLORS.ENEMY_HIT_FLASH;
            }
            
            // Glow effect
            ctx.save();
            ctx.shadowBlur = SHADOW_BLUR;
            ctx.shadowColor = enemy.color;
            
            // Draw glow layer
            ctx.globalAlpha = GLOW_OPACITY;
            this.drawEnemyShape(ctx, centerX, centerY, enemy.shape, drawColor, 1.2);
            
            // Draw main enemy
            ctx.globalAlpha = 1;
            this.drawEnemyShape(ctx, centerX, centerY, enemy.shape, drawColor, 1);
            
            ctx.restore();
        }
    }
    
    drawEnemyShape(ctx, x, y, shape, color, scale) {
        ctx.fillStyle = color;
        
        switch (shape) {
            case 'diamond':
                // Type A - Diamond shape
                ctx.beginPath();
                ctx.moveTo(x, y - 15 * scale);
                ctx.lineTo(x + 17 * scale, y);
                ctx.lineTo(x, y + 15 * scale);
                ctx.lineTo(x - 17 * scale, y);
                ctx.closePath();
                ctx.fill();
                break;
                
            case 'hexagon':
                // Type B - Hexagon shape
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = (i * Math.PI) / 3 - Math.PI / 6;
                    const px = x + 18 * scale * Math.cos(angle);
                    const py = y + 15 * scale * Math.sin(angle);
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fill();
                break;
                
            case 'triangle':
                // Type C - Triangle shape (jittering)
                const jitter = Math.sin(this.animTimer) * 2;
                ctx.beginPath();
                ctx.moveTo(x, y - 15 * scale);
                ctx.lineTo(x + 18 * scale, y + 12 * scale + jitter);
                ctx.lineTo(x - 18 * scale, y + 12 * scale + jitter);
                ctx.closePath();
                ctx.fill();
                break;
        }
        
        // Inner highlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(x, y, 5 * scale, 0, Math.PI * 2);
        ctx.fill();
    }
    
    isAllDead() {
        return this.aliveCount === 0;
    }
}

// Add fire speed to ENEMY config
ENEMY.FIRE_SPEED = 200;

// Export for instantiation
export const enemyFactory = (level) => new EnemyGrid(level);