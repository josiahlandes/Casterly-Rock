// Projectile Manager for player and enemy bullets
export default class ProjectileManager {
    constructor(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.playerBullets = [];
        this.enemyBullets = [];
        this.bulletSpeed = 700;
        this.playerWidth = 4;
        this.playerHeight = 15;
        this.enemyWidth = 5;
        this.enemyHeight = 12;
        this.maxPlayerBullets = 3;
    }
    
    update(dt) {
        const dtSeconds = dt / 1000;
        
        // Update player bullets
        for (let i = this.playerBullets.length - 1; i >= 0; i--) {
            const bullet = this.playerBullets[i];
            bullet.y -= this.bulletSpeed * dtSeconds;
            
            // Remove if off screen
            if (bullet.y + this.playerHeight < 0) {
                this.playerBullets.splice(i, 1);
            }
        }
        
        // Update enemy bullets
        for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
            const bullet = this.enemyBullets[i];
            bullet.y += this.bulletSpeed * 0.6 * dtSeconds; // Enemy bullets slower
            
            // Remove if off screen
            if (bullet.y > this.canvasHeight) {
                this.enemyBullets.splice(i, 1);
            }
        }
    }
    
    addPlayerBullets(bullets) {
        // Check if we can add more bullets
        const availableSlots = this.maxPlayerBullets - this.playerBullets.length;
        const bulletsToAdd = bullets.slice(0, availableSlots);
        
        bulletsToAdd.forEach(bullet => {
            this.playerBullets.push({
                x: bullet.x,
                y: bullet.y,
                vx: bullet.vx || 0,
                width: this.playerWidth,
                height: this.playerHeight,
                color: '#00fff5'
            });
        });
    }
    
    addEnemyBullet(x, y) {
        if (this.enemyBullets.length < 10) { // Limit enemy bullets
            this.enemyBullets.push({
                x: x,
                y: y,
                vx: 0,
                width: this.enemyWidth,
                height: this.enemyHeight,
                color: '#ff3333'
            });
        }
    }
    
    getPlayerBullets() {
        return this.playerBullets;
    }
    
    getEnemyBullets() {
        return this.enemyBullets;
    }
    
    clear() {
        this.playerBullets = [];
        this.enemyBullets = [];
    }
    
    draw(ctx) {
        // Draw player bullets
        this.playerBullets.forEach(bullet => {
            ctx.save();
            ctx.shadowBlur = 10;
            ctx.shadowColor = bullet.color;
            ctx.fillStyle = bullet.color;
            
            // Draw bullet with glow
            ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
            
            // Inner bright core
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(bullet.x + 1, bullet.y + 2, bullet.width - 2, bullet.height - 4);
            
            ctx.restore();
        });
        
        // Draw enemy bullets
        this.enemyBullets.forEach(bullet => {
            ctx.save();
            ctx.shadowBlur = 8;
            ctx.shadowColor = bullet.color;
            ctx.fillStyle = bullet.color;
            
            // Draw enemy bullet (slightly different shape)
            ctx.beginPath();
            ctx.ellipse(
                bullet.x + bullet.width / 2,
                bullet.y + bullet.height / 2,
                bullet.width / 2,
                bullet.height / 2,
                0, 0, Math.PI * 2
            );
            ctx.fill();
            
            ctx.restore();
        });
    }
    
    getPlayerBulletCount() {
        return this.playerBullets.length;
    }
}
