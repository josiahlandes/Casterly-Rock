// Player Ship Controller
export default class Player {
    constructor(x, y, particleSystem) {
        this.x = x;
        this.y = y;
        this.width = 40;
        this.height = 30;
        this.vx = 0;
        this.speed = 500;
        this.maxSpeed = 400;
        this.acceleration = 800;
        this.deceleration = 600;
        this.shield = 3;
        this.maxShield = 3;
        this.lastShotTime = 0;
        this.fireCooldown = 250;
        this.rapidFireCooldown = 125;
        this.rapidFireTime = 0;
        this.spreadShotTime = 0;
        this.spreadAngle = 0.3;
        this.bulletWidth = 4;
        this.bulletHeight = 15;
        this.color = '#00fff5';
        this.invulnerable = false;
        this.invulnerableTime = 0;
        this.blinkTime = 0;
    }
    
    update(dt, input, canvasWidth, particleSystem) {
        const dtSeconds = dt / 1000;
        
        // Update power-up timers
        if (this.rapidFireTime > 0) {
            this.rapidFireTime -= dt;
            if (this.rapidFireTime <= 0) this.rapidFireTime = 0;
        }
        
        if (this.spreadShotTime > 0) {
            this.spreadShotTime -= dt;
            if (this.spreadShotTime <= 0) this.spreadShotTime = 0;
        }
        
        // Update invulnerability
        if (this.invulnerable) {
            this.invulnerableTime -= dt;
            this.blinkTime += dt;
            if (this.invulnerableTime <= 0) {
                this.invulnerable = false;
                this.blinkTime = 0;
            }
        }
        
        // Movement with acceleration/deceleration
        if (input.isLeft()) {
            this.vx -= this.acceleration * dtSeconds;
        } else if (input.isRight()) {
            this.vx += this.acceleration * dtSeconds;
        } else {
            // Decelerate
            if (this.vx > 0) {
                this.vx = Math.max(0, this.vx - this.deceleration * dtSeconds);
            } else if (this.vx < 0) {
                this.vx = Math.min(0, this.vx + this.deceleration * dtSeconds);
            }
        }
        
        // Clamp velocity
        this.vx = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, this.vx));
        
        // Update position
        this.x += this.vx * dtSeconds;
        
        // Clamp to screen
        this.x = Math.max(0, Math.min(canvasWidth - this.width, this.x));
        
        // Thruster particles when moving
        if (Math.abs(this.vx) > 50) {
            particleSystem.createThruster(this.x + this.width / 2, this.y + this.height);
        }
    }
    
    shoot(currentTime) {
        const cooldown = this.rapidFireTime > 0 ? this.rapidFireCooldown : this.fireCooldown;
        
        if (currentTime - this.lastShotTime > cooldown) {
            this.lastShotTime = currentTime;
            
            if (this.spreadShotTime > 0) {
                // Spread shot - 3 bullets
                return [
                    { x: this.x + this.width / 2 - this.bulletWidth / 2, y: this.y, vx: 0 },
                    { x: this.x + this.width / 2 - this.bulletWidth / 2, y: this.y, vx: -Math.sin(this.spreadAngle) * this.speed * 0.5 },
                    { x: this.x + this.width / 2 - this.bulletWidth / 2, y: this.y, vx: Math.sin(this.spreadAngle) * this.speed * 0.5 }
                ];
            } else {
                // Single bullet
                return [{ x: this.x + this.width / 2 - this.bulletWidth / 2, y: this.y, vx: 0 }];
            }
        }
        return [];
    }
    
    takeDamage() {
        if (this.invulnerable) return false;
        
        this.shield--;
        if (this.shield <= 0) {
            this.shield = 0;
            return true; // Game over
        } else {
            this.invulnerable = true;
            this.invulnerableTime = 2000;
            this.blinkTime = 0;
            return false;
        }
    }
    
    restoreShield() {
        this.shield = Math.min(this.shield + 1, this.maxShield);
    }
    
    activateRapidFire() {
        this.rapidFireTime = 8000;
    }
    
    activateSpreadShot() {
        this.spreadShotTime = 8000;
    }
    
    isAlive() {
        return this.shield > 0;
    }
    
    draw(ctx) {
        // Check if should blink (invulnerable)
        if (this.invulnerable) {
            const blinkInterval = 100;
            if (Math.floor(this.blinkTime / blinkInterval) % 2 === 0) {
                return; // Skip drawing this frame
            }
        }
        
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        
        ctx.save();
        
        // Glow effect
        ctx.shadowBlur = 15;
        ctx.shadowColor = this.color;
        
        // Draw ship body (triangle shape)
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.moveTo(centerX, this.y);
        ctx.lineTo(this.x + this.width, this.y + this.height);
        ctx.lineTo(this.x + this.width / 2, this.y + this.height - 8);
        ctx.lineTo(this.x, this.y + this.height);
        ctx.closePath();
        ctx.fill();
        
        // White core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(centerX, this.y + 5);
        ctx.lineTo(this.x + this.width - 8, this.y + this.height - 5);
        ctx.lineTo(centerX, this.y + this.height - 12);
        ctx.lineTo(this.x + 8, this.y + this.height - 5);
        ctx.closePath();
        ctx.fill();
        
        ctx.restore();
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
