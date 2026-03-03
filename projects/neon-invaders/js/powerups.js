// Power-up Manager
export default class PowerUpManager {
    constructor(canvasWidth, canvasHeight, particleSystem) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.particleSystem = particleSystem;
        this.powerUps = [];
        this.dropChance = 0.1;
        this.width = 25;
        this.height = 25;
        this.speed = 80;
        this.pulseTime = 0;
    }
    
    update(dt) {
        const dtSeconds = dt / 1000;
        this.pulseTime += dtSeconds;
        
        // Update power-up positions
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const powerUp = this.powerUps[i];
            powerUp.y += this.speed * dtSeconds;
            powerUp.life -= dt;
            
            // Remove if off screen or expired
            if (powerUp.y > this.canvasHeight || powerUp.life <= 0) {
                this.powerUps.splice(i, 1);
            }
        }
    }
    
    tryDrop(x, y) {
        if (Math.random() < this.dropChance) {
            const types = ['rapid', 'shield', 'spread'];
            const type = types[Math.floor(Math.random() * types.length)];
            
            this.powerUps.push({
                x: x,
                y: y,
                type: type,
                width: this.width,
                height: this.height,
                life: 5000 // 5 seconds to collect
            });
            return true;
        }
        return false;
    }
    
    checkCollection(player) {
        const playerBounds = player.getBounds();
        
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const powerUp = this.powerUps[i];
            
            // Simple AABB collision
            if (playerBounds.x < powerUp.x + powerUp.width &&
                playerBounds.x + playerBounds.width > powerUp.x &&
                playerBounds.y < powerUp.y + powerUp.height &&
                playerBounds.y + playerBounds.height > powerUp.y) {
                
                // Collect power-up
                this.particleSystem.createPowerUpCollect(
                    powerUp.x + powerUp.width / 2,
                    powerUp.y + powerUp.height / 2
                );
                
                const collected = this.powerUps[i];
                this.powerUps.splice(i, 1);
                
                return collected;
            }
        }
        return null;
    }
    
    getPowerUpEffect(type) {
        switch (type) {
            case 'rapid':
                return { type: 'rapid', duration: 8000 };
            case 'shield':
                return { type: 'shield' };
            case 'spread':
                return { type: 'spread', duration: 8000 };
            default:
                return null;
        }
    }
    
    getIcon(type) {
        switch (type) {
            case 'rapid':
                return '↑↑';
            case 'shield':
                return '⛡';
            case 'spread':
                return '↗↑↖';
            default:
                return '?';
        }
    }
    
    draw(ctx) {
        this.powerUps.forEach(powerUp => {
            const centerX = powerUp.x + powerUp.width / 2;
            const centerY = powerUp.y + powerUp.height / 2;
            
            // Calculate pulse
            const pulse = 1 + 0.2 * Math.sin(this.pulseTime * 3);
            const drawWidth = powerUp.width * pulse;
            const drawHeight = powerUp.height * pulse;
            const offsetX = (powerUp.width - drawWidth) / 2;
            const offsetY = (powerUp.height - drawHeight) / 2;
            
            ctx.save();
            
            // Gold glow
            ctx.shadowBlur = 15;
            ctx.shadowColor = '#ffd700';
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 2;
            
            // Draw pulsing outline
            ctx.strokeRect(
                powerUp.x + offsetX,
                powerUp.y + offsetY,
                drawWidth,
                drawHeight
            );
            
            // Draw icon
            ctx.fillStyle = '#ffd700';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
                this.getIcon(powerUp.type),
                centerX,
                centerY
            );
            
            ctx.restore();
        });
    }
    
    clear() {
        this.powerUps = [];
    }
}
