// Enemies - Enemy grid, formation, types A/B/C
import { CONFIG } from './config.js';

export class Enemy {
    constructor(x, y, type) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.active = true;
        this.hitFlashTime = 0;
        
        // Set properties based on type
        switch(type) {
            case 'A': // Drone
                this.hp = CONFIG.ENEMY_A_HP;
                this.points = CONFIG.ENEMY_A_POINTS;
                this.speed = CONFIG.ENEMY_A_SPEED;
                this.color = CONFIG.COLORS.ENEMY_A;
                break;
            case 'B': // Tank
                this.hp = CONFIG.ENEMY_B_HP;
                this.points = CONFIG.ENEMY_B_POINTS;
                this.speed = CONFIG.ENEMY_B_SPEED;
                this.color = CONFIG.COLORS.ENEMY_B;
                break;
            case 'C': // Scout
                this.hp = CONFIG.ENEMY_C_HP;
                this.points = CONFIG.ENEMY_C_POINTS;
                this.speed = CONFIG.ENEMY_C_SPEED;
                this.color = CONFIG.COLORS.ENEMY_C;
                break;
        }
        
        // Idle animation
        this.pulsePhase = Math.random() * Math.PI * 2;
    }
    
    hit() {
        this.hp--;
        this.hitFlashTime = 0.15;
        return this.hp <= 0;
    }
    
    update(dt, level) {
        // Update hit flash
        if (this.hitFlashTime > 0) {
            this.hitFlashTime -= dt;
        }
        
        // Update idle animation
        this.pulsePhase += dt * 3;
    }
    
    draw(ctx) {
        const alpha = this.hitFlashTime > 0 ? 1 : 0.8 + Math.sin(this.pulsePhase) * 0.2;
        const drawY = this.y;
        
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 15;
        ctx.shadowColor = this.color;
        ctx.fillStyle = this.hitFlashTime > 0 ? '#ffffff' : this.color;
        
        const w = CONFIG.ENEMY_WIDTH;
        const h = CONFIG.ENEMY_HEIGHT;
        const cx = this.x + w / 2;
        const cy = drawY + h / 2;
        
        // Draw based on type
        if (this.type === 'A') {
            // Diamond shape
            ctx.beginPath();
            ctx.moveTo(cx, cy - h/2);
            ctx.lineTo(cx + w/2, cy);
            ctx.lineTo(cx, cy + h/2);
            ctx.lineTo(cx - w/2, cy);
            ctx.closePath();
            ctx.fill();
        } else if (this.type === 'B') {
            // Hexagon
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i - Math.PI / 6;
                const px = cx + (w/2) * Math.cos(angle);
                const py = cy + (h/2) * Math.sin(angle);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
        } else if (this.type === 'C') {
            // Triangle (pointing up)
            ctx.beginPath();
            ctx.moveTo(cx, cy - h/2);
            ctx.lineTo(cx + w/2, cy + h/2);
            ctx.lineTo(cx - w/2, cy + h/2);
            ctx.closePath();
            ctx.fill();
        }
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }
    
    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: CONFIG.ENEMY_WIDTH,
            height: CONFIG.ENEMY_HEIGHT
        };
    }
}

export class EnemyGrid {
    constructor() {
        this.enemies = [];
        this.gridOffsetX = 0;
        this.gridOffsetY = 0;
        this.direction = 1; // 1 = right, -1 = left
        this.moveTimer = 0;
        this.moveInterval = 1; // seconds between moves
        this.shootTimer = 0;
        this.shootInterval = 2; // seconds between shoot attempts
        this.pendingShooter = null; // queued shooter for main loop to consume
    }
    
    spawn(level) {
        this.enemies = [];
        this.gridOffsetX = 0;
        this.gridOffsetY = 0;
        this.direction = 1;
        
        const rows = CONFIG.ENEMY_ROWS;
        const cols = CONFIG.ENEMY_COLS;
        const padding = CONFIG.ENEMY_PADDING;
        const totalWidth = cols * CONFIG.ENEMY_WIDTH + (cols - 1) * padding;
        const startX = (CONFIG.CANVAS_WIDTH - totalWidth) / 2;
        
        // Determine enemy types based on level
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                let type = 'A';
                
                if (level >= 2) {
                    // Back rows are B (tank)
                    if (row >= rows - 2) {
                        type = 'B';
                    } else {
                        type = 'A';
                    }
                }
                
                if (level >= 3) {
                    // Front row is C (scout)
                    if (row === 0) {
                        type = 'C';
                    } else if (row >= rows - 2) {
                        type = 'B';
                    } else {
                        type = 'A';
                    }
                }
                
                const x = startX + col * (CONFIG.ENEMY_WIDTH + padding);
                const y = CONFIG.ENEMY_START_Y + row * (CONFIG.ENEMY_HEIGHT + padding) + this.gridOffsetY;
                
                this.enemies.push(new Enemy(x, y, type));
            }
        }
    }
    
    update(dt, level) {
        // Update individual enemies
        this.enemies.forEach(enemy => {
            if (enemy.active) {
                enemy.update(dt, level);
            }
        });
        
        // Formation movement
        this.moveTimer += dt;
        const baseInterval = this.getMoveInterval(level);
        
        if (this.moveTimer >= baseInterval) {
            this.moveTimer = 0;
            this.moveFormation();
        }
        
        // Random shooting (queue a shooter for main loop to consume)
        this.shootTimer += dt;
        const shootInterval = this.getShootInterval(level);

        if (this.shootTimer >= shootInterval) {
            this.shootTimer = 0;
            const aliveEnemies = this.enemies.filter(e => e.active);
            if (aliveEnemies.length > 0) {
                this.pendingShooter = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
            }
        }
    }
    
    getMoveInterval(level) {
        // Speed increases as enemies are destroyed and with level
        const aliveCount = this.getAliveCount();
        const totalEnemies = CONFIG.ENEMY_ROWS * CONFIG.ENEMY_COLS;
        const speedMultiplier = 1 + (1 - aliveCount / totalEnemies) * 2;
        const levelMultiplier = 1 + (level - 1) * 0.1;
        return Math.max(0.15, CONFIG.FORMATION_MOVE_SPEED / (speedMultiplier * levelMultiplier * 50));
    }
    
    getShootInterval(level) {
        let interval = 2 - level * 0.15;
        interval = Math.max(0.5, interval);
        
        // Every 5 levels, enemies fire 50% more frequently
        if (level % CONFIG.LEVEL_BONUS_FREQUENCY === 0) {
            interval *= (1 / CONFIG.BONUS_FREQUENCY_MULTIPLIER);
        }
        
        return interval;
    }
    
    moveFormation() {
        const aliveEnemies = this.enemies.filter(e => e.active);
        if (aliveEnemies.length === 0) return;

        // Find bounds of alive enemies
        let minX = Infinity, maxX = -Infinity;
        aliveEnemies.forEach(e => {
            minX = Math.min(minX, e.x);
            maxX = Math.max(maxX, e.x + CONFIG.ENEMY_WIDTH);
        });

        // Check if we hit the edge
        if ((this.direction === 1 && maxX > CONFIG.CANVAS_WIDTH - 20) ||
            (this.direction === -1 && minX < 20)) {
            // Drop down and reverse
            aliveEnemies.forEach(e => {
                e.y += CONFIG.ENEMY_DROP_DISTANCE;
            });
            this.direction *= -1;
        } else {
            // Move horizontally
            const step = CONFIG.FORMATION_MOVE_SPEED * this.direction * 0.02;
            aliveEnemies.forEach(e => {
                e.x += step;
            });
        }
    }
    
    consumeShooter() {
        const shooter = this.pendingShooter;
        this.pendingShooter = null;
        return shooter;
    }
    
    hitEnemy(enemy) {
        const destroyed = enemy.hit();
        if (destroyed) {
            enemy.active = false;
            return true;
        }
        return false;
    }
    
    getAliveCount() {
        return this.enemies.filter(e => e.active).length;
    }
    
    isCleared() {
        return this.getAliveCount() === 0;
    }
    
    reachesPlayerRow(playerY) {
        const aliveEnemies = this.enemies.filter(e => e.active);
        if (aliveEnemies.length === 0) return false;
        
        const lowestEnemy = Math.max(...aliveEnemies.map(e => e.y + CONFIG.ENEMY_HEIGHT));
        return lowestEnemy >= playerY - 20;
    }
    
    draw(ctx) {
        this.enemies.forEach(enemy => {
            if (enemy.active) {
                enemy.draw(ctx);
            }
        });
    }
    
    getBounds() {
        const aliveEnemies = this.enemies.filter(e => e.active);
        if (aliveEnemies.length === 0) return null;
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        aliveEnemies.forEach(e => {
            minX = Math.min(minX, e.x);
            minY = Math.min(minY, e.y);
            maxX = Math.max(maxX, e.x + CONFIG.ENEMY_WIDTH);
            maxY = Math.max(maxY, e.y + CONFIG.ENEMY_HEIGHT);
        });
        
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
}