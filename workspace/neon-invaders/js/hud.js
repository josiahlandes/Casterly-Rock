// HUD Module (Heads-Up Display)

import { COLORS, SHADOW_BLUR, CANVAS } from './config.js';

export class HUD {
    constructor() {
        this.score = 0;
        this.highScore = this.loadHighScore();
        this.lives = 3;
        this.level = 1;
        this.shield = 3;
        this.maxShield = 3;
        this.combo = 0;
        this.comboMultiplier = 1;
        this.comboTimer = 0;
        
        // Animation states
        this.scorePopTimer = 0;
        this.comboTextTimer = 0;
        this.comboText = '';
    }
    
    loadHighScore() {
        const saved = localStorage.getItem('neonInvadersHighScore');
        return saved ? parseInt(saved, 10) : 0;
    }
    
    saveHighScore() {
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem('neonInvadersHighScore', this.highScore);
        }
    }
    
    setScore(score) {
        this.score = score;
        this.scorePopTimer = 0;
    }

    addScore(basePoints, multiplier) {
        const points = basePoints * multiplier;
        this.score += points;
        this.scorePopTimer = 0.15; // 150ms pop animation
        
        // Save high score if new record
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem('neonInvadersHighScore', this.highScore);
        }
    }
    
    updateCombo(killed) {
        if (killed) {
            this.comboTimer = 1.5;
            this.combo++;
            this.comboMultiplier = Math.min(this.combo, 5);
            
            // Show combo text when multiplier increases
            if (this.comboMultiplier > 1 && this.combo === this.comboMultiplier) {
                this.comboText = `x${this.comboMultiplier} COMBO!`;
                this.comboTextTimer = 1.0;
            }
        } else {
            this.comboTimer -= 0.016; // Approximate per-frame decrement
            if (this.comboTimer <= 0) {
                this.combo = 0;
                this.comboMultiplier = 1;
            }
        }
        
        if (this.comboTextTimer > 0) {
            this.comboTextTimer -= 0.016;
        }
    }
    
    resetCombo() {
        this.combo = 0;
        this.comboMultiplier = 1;
        this.comboTextTimer = 0;
    }
    
    setLevel(level) {
        this.level = level;
    }
    
    setShield(shield) {
        this.shield = Math.max(0, Math.min(shield, this.maxShield));
    }
    
    setLives(lives) {
        this.lives = lives;
    }
    
    draw(ctx) {
        ctx.save();
        
        // Score (top left)
        ctx.shadowBlur = SHADOW_BLUR;
        ctx.shadowColor = COLORS.HUD_TEXT;
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.font = 'bold 20px Courier New';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        // Score with pop animation
        let scoreText = `SCORE: ${this.score}`;
        if (this.scorePopTimer > 0) {
            const scale = 1 + this.scorePopTimer * 2;
            ctx.save();
            ctx.translate(10, 10);
            ctx.scale(scale, scale);
            ctx.fillText(scoreText, 0, 0);
            ctx.restore();
        } else {
            ctx.fillText(scoreText, 10, 10);
        }
        
        // High score (top right)
        ctx.textAlign = 'right';
        ctx.fillText(`HI: ${this.highScore}`, CANVAS.WIDTH - 10, 10);
        
        // Level (top center)
        ctx.textAlign = 'center';
        ctx.fillText(`LEVEL ${this.level}`, CANVAS.WIDTH / 2, 10);
        
        // Shield bar (below score, left side)
        this.drawShieldBar(ctx);
        
        // Combo display (center, when active)
        if (this.comboMultiplier > 1) {
            this.drawCombo(ctx);
        }
        
        ctx.restore();
    }
    
    drawShieldBar(ctx) {
        const barX = 10;
        const barY = 40;
        const barWidth = 100;
        const barHeight = 12;
        
        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(barX, barY, barWidth, barHeight);
        
        // Shield segments
        const segmentWidth = barWidth / this.maxShield;
        
        for (let i = 0; i < this.maxShield; i++) {
            const segmentX = barX + i * segmentWidth;
            
            if (i < this.shield) {
                // Active shield segment with gradient
                const gradient = ctx.createLinearGradient(segmentX, barY, segmentX + segmentWidth, barY);
                gradient.addColorStop(0, COLORS.SHIELD_GRADIENT_START);
                gradient.addColorStop(1, COLORS.SHIELD_GRADIENT_END);
                ctx.fillStyle = gradient;
                ctx.shadowColor = COLORS.SHIELD_GRADIENT_START;
                ctx.shadowBlur = SHADOW_BLUR;
            } else {
                // Empty segment
                ctx.fillStyle = 'rgba(100, 100, 100, 0.3)';
                ctx.shadowBlur = 0;
            }
            
            ctx.fillRect(segmentX + 1, barY + 1, segmentWidth - 2, barHeight - 2);
        }
        
        // Shield label
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.shadowBlur = SHADOW_BLUR;
        ctx.font = '12px Courier New';
        ctx.textAlign = 'left';
        ctx.fillText('SHIELD', barX, barY + barHeight + 12);
    }
    
    drawCombo(ctx) {
        const text = this.comboText || `x${this.comboMultiplier} COMBO`;
        const centerX = CANVAS.WIDTH / 2;
        const centerY = 150;
        
        // Fade out effect
        const alpha = Math.min(1, this.comboTextTimer);
        
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = SHADOW_BLUR * 2;
        ctx.shadowColor = COLORS.COMBO_TEXT;
        ctx.fillStyle = COLORS.COMBO_TEXT;
        ctx.font = 'bold 48px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, centerX, centerY);
        ctx.restore();
    }
    
    drawLevelTransition(ctx) {
        ctx.save();
        
        // Semi-transparent overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, CANVAS.WIDTH, CANVAS.HEIGHT);
        
        // Level text
        ctx.shadowBlur = SHADOW_BLUR * 3;
        ctx.shadowColor = COLORS.HUD_TEXT;
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.font = 'bold 72px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`LEVEL ${this.level}`, CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2);
        
        ctx.restore();
    }
    
    drawGameOver(ctx) {
        ctx.save();
        
        // Semi-transparent overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, 0, CANVAS.WIDTH, CANVAS.HEIGHT);
        
        // Game Over text
        ctx.shadowBlur = SHADOW_BLUR * 3;
        ctx.shadowColor = '#ff0000';
        ctx.fillStyle = '#ff0000';
        ctx.font = 'bold 72px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GAME OVER', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 - 50);
        
        // Final score
        ctx.shadowColor = COLORS.HUD_TEXT;
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.font = 'bold 36px Courier New';
        ctx.fillText(`Final Score: ${this.score}`, CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 20);
        
        // Level reached
        ctx.font = 'bold 24px Courier New';
        ctx.fillText(`Level: ${this.level}`, CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 60);
        
        // Restart prompt
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px Courier New';
        ctx.fillText('Press ENTER to restart', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 120);
        
        ctx.restore();
    }
    
    drawMenu(ctx) {
        ctx.save();
        
        // Title
        ctx.shadowBlur = SHADOW_BLUR * 3;
        ctx.shadowColor = COLORS.HUD_TEXT;
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.font = 'bold 64px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEON INVADERS', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 - 100);
        
        // Subtitle
        ctx.shadowColor = COLORS.POWERUP;
        ctx.fillStyle = COLORS.POWERUP;
        ctx.font = 'bold 24px Courier New';
        ctx.fillText('A Retro Futuristic Shooter', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 - 40);
        
        // High score
        ctx.shadowColor = COLORS.HUD_TEXT;
        ctx.fillStyle = COLORS.HUD_TEXT;
        ctx.font = 'bold 20px Courier New';
        ctx.fillText(`High Score: ${this.highScore}`, CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 20);
        
        // Start prompt
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px Courier New';
        ctx.fillText('Press ENTER to start', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 80);
        
        // Controls
        ctx.font = '14px Courier New';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fillText('Arrow Keys / A-D: Move', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 130);
        ctx.fillText('Space: Shoot', CANVAS.WIDTH / 2, CANVAS.HEIGHT / 2 + 155);
        
        ctx.restore();
    }
}

// Export singleton
export const hud = new HUD();