// Enemy Grid System
export default class EnemyGrid {
    constructor(canvasWidth, canvasHeight, particleSystem, audioController) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.particleSystem = particleSystem;
        this.audioController = audioController;
        
        this.enemies = [];
        this.direction = 1; // 1 = right, -1 = left
        this.speed = 50;
        this.baseSpeed = 50;
        this.edgeShiftY = 20;
        this.fireChance = 0.0005;
        this.idlePulseTime = 0;
        
        this.rows = 5;
        this.cols = 8;
        this.startX = 80;
        this.startY = 60;
        this.spacingX = 60;
        this.spacingY = 45;
    }
    
    spawn(level) {
        this.enemies = [];
        this.level = level;
        
        // Calculate starting Y based on level (starts lower each level)
        const startY = Math.max(20, this.startY - (level - 1) * 10);
        
        // Determine enemy types based on level
        const hasTypeB = level >= 2;
        const hasTypeC = level >= 3;
        
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                let type = 'A';
                
                if (hasTypeC && row === 0) {
                    type = 'C'; // Front row = scouts
                } else if (hasTypeB && row >= this.rows - 2) {
                    type = 'B'; // Back rows = tanks
                }
                
                const x = this.startX + col * this.spacingX;
                const y = startY + row * this.spacingY;
                
                this.enemies.push(this.createEnemy(x, y, type, row, col));
            }
        }
        
        this.speed = this.baseSpeed;
        this.direction = 1;
    }
    
    createEnemy(x, y, type, row, col) {
        const typeData = {
            A: { width: 35, height: 25, hp: 1, points: 100, color: '#ff00ff', speedMod: 1.0 },
            B: { width: 40, height: 30, hp: 2, points: 250, color: '#ff6600', speedMod: 0.7 },
            C: { width: 30, height: 22, hp: 1, points: 200, color: '#39ff14', speedMod: 1.4 }
        }[type];
        
        return {
            x: x,
            y: y,
            type: type,
            width: typeData.width,
            height: typeData.height,
            hp: typeData.hp,
            maxHp: typeData.hp,
            points: typeData.points,
            color: typeData.color,
            speedMod: typeData.speedMod,
            row: row,
            col: col,
            pulsePhase: Math.random() * Math.PI * 2,
            hitFlashTime: 0
        };
    }
    
    update(dt, playerBulletCount) {
        const dtSeconds = dt / 1000;
        
        // Update idle pulse animation
        this.idlePulseTime += dtSeconds;
        
        // Update hit flash timers
        this.enemies.forEach(enemy => {
            if (enemy.hitFlashTime > 0) {
                enemy.hitFlashTime -= dt;
            }
        });
        
        // Calculate movement speed based on remaining enemies
        const enemyCount = this.enemies.length;
        const totalEnemies = this.rows * this.cols;
        const speedMultiplier = 1 + (totalEnemies - enemyCount) * 0.02;
        const currentSpeed = this.speed * speedMultiplier;
        
        // Move enemies
        let hitEdge = false;
        let lowestY = 0;
        
        this.enemies.forEach(enemy => {
            enemy.x += currentSpeed * enemy.speedMod * this.direction * dtSeconds;
            
            // Check edges
            if (this.direction > 0 && enemy.x + enemy.width > this.canvasWidth - 20) {
                hitEdge = true;
            } else if (this.direction < 0 && enemy.x < 20) {
                hitEdge = true;
            }
            
            // Track lowest enemy
            if (enemy.y + enemy.height > lowestY) {
                lowestY = enemy.y + enemy.height;
            }
            
            // Update pulse phase
            enemy.pulsePhase += 2 * dtSeconds;
        });
        
        // Shift down and reverse direction if hitting edge
        if (hitEdge) {
            this.direction *= -1;
            this.enemies.forEach(enemy => {
                enemy.y += this.edgeShiftY;
            });
        }
        
        // Random enemy firing
        const adjustedFireChance = this.fireChance * speedMultiplier * this.getFireMultiplier();
        this.enemies.forEach(enemy => {
            if (Math.random() < adjustedFireChance && playerBulletCount < 5) {
                return { x: enemy.x + enemy.width / 2, y: enemy.y + enemy.height, type: enemy.type };
            }
            return null;
        }).filter(fire => fire !== null).forEach(fire => {
            // This will be handled by the caller
        });
        
        return {
            lowestY: lowestY,
            fireCandidates: this.enemies.filter(() => Math.random() < adjustedFireChance)
        };
    }
    
    getFireMultiplier() {
        // Every 5 levels, enemies fire 50% more
        return Math.floor(this.level / 5) > 0 ? 1.5 : 1.0;
    }
    
    takeDamage(enemy, damage = 1) {
        enemy.hp -= damage;
        enemy.hitFlashTime = 100;
        
        if (enemy.hp <= 0) {
            // Enemy destroyed
            this.particleSystem.createExplosion(
                enemy.x + enemy.width / 2,
                enemy.y + enemy.height / 2,
                enemy.color
            );
            this.audioController.playEnemyDestroyed();
            return { destroyed: true, points: enemy.points };
        }
        
        return { destroyed: false };
    }
    
    getRandomFireTarget() {
        if (this.enemies.length === 0) return null;
        return this.enemies[Math.floor(Math.random() * this.enemies.length)];
    }
    
    isEmpty() {
        return this.enemies.length === 0;
    }
    
    getEnemyCount() {
        return this.enemies.length;
    }
    
    draw(ctx) {
        this.enemies.forEach(enemy => {
            const centerX = enemy.x + enemy.width / 2;
            const centerY = enemy.y + enemy.height / 2;
            
            // Calculate pulse for idle animation
            const pulse = 1 + 0.1 * Math.sin(enemy.pulsePhase);
            const drawWidth = enemy.width * pulse;
            const drawHeight = enemy.height * pulse;
            const offsetX = (enemy.width - drawWidth) / 2;
            const offsetY = (enemy.height - drawHeight) / 2;
            
            ctx.save();
            
            // Glow effect
            ctx.shadowBlur = 10;
            ctx.shadowColor = enemy.hitFlashTime > 0 ? '#ffffff' : enemy.color;
            
            // Draw based on type
            if (enemy.hitFlashTime > 0) {
                ctx.fillStyle = '#ffffff';
            } else {
                ctx.fillStyle = enemy.color;
            }
            
            switch (enemy.type) {
                case 'A': // Drone - diamond
                    ctx.beginPath();
                    ctx.moveTo(centerX, enemy.y + offsetY);
                    ctx.lineTo(enemy.x + drawWidth + offsetX, centerY);
                    ctx.lineTo(centerX, enemy.y + drawHeight + offsetY);
                    ctx.lineTo(enemy.x + offsetX, centerY);
                    ctx.closePath();
                    ctx.fill();
                    break;
                    
                case 'B': // Tank - hexagon
                    ctx.beginPath();
                    ctx.moveTo(centerX - drawWidth / 2, centerY - drawHeight / 3);
                    ctx.lineTo(centerX + drawWidth / 2, centerY - drawHeight / 3);
                    ctx.lineTo(centerX + drawWidth / 2, centerY + drawHeight / 3);
                    ctx.lineTo(centerX, centerY + drawHeight / 2);
                    ctx.lineTo(centerX - drawWidth / 2, centerY + drawHeight / 3);
                    ctx.closePath();
                    ctx.fill();
                    break;
                    
                case 'C': // Scout - triangle with jitter
                    const jitterX = (Math.random() - 0.5) * 2;
                    ctx.beginPath();
                    ctx.moveTo(centerX + jitterX, enemy.y + offsetY);
                    ctx.lineTo(enemy.x + drawWidth + offsetX, enemy.y + drawHeight + offsetY);
                    ctx.lineTo(enemy.x + offsetX, enemy.y + drawHeight + offsetY);
                    ctx.closePath();
                    ctx.fill();
                    break;
            }
            
            ctx.restore();
        });
    }
    
    reset() {
        this.enemies = [];
    }
}
