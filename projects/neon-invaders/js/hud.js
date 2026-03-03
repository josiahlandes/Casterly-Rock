// HUD System - Score, Lives, Level, Shield Bar, Combo Display

import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, PLAYER, COMBO, ANIMATION } from './config.js';
import { HIGH_SCORE_KEY } from './config.js';

class HUD {
    constructor() {
        this.score = 0;
        this.highScore = this.loadHighScore();
        this.lives = PLAYER.shieldMax;
        this.level = 1;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboMultiplier = 1;
        
        // Score pop animation
        this.scorePopTimer = 0;
        this.scorePopScale = 1;
        
        // Combo flash text
        this.comboFlashText = '';
        this.comboFlashTimer = 0;
    }
    
    loadHighScore() {
        const saved = localStorage.getItem(HIGH_SCORE_KEY);
        return saved ? parseInt(saved, 10) : 0;
    }
    
    saveHighScore() {
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem(HIGH_SCORE_KEY, this.highScore.toString());
        }
    }
    
    reset() {
        this.score = 0;
        this.lives = PLAYER.shieldMax;
        this.level = 1;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboMultiplier = 1;
        this.scorePopTimer = 0;
        this.comboFlashTimer = 0;
    }
    
    addScore(basePoints) {
        const points = basePoints * this.comboMultiplier;
        this.score += points;
        this.scorePopTimer = ANIMATION.scorePopDuration;
        this.saveHighScore();
    }
    
    updateCombo(killed) {
        if (killed) {
            this.combo++;
            this.comboTimer = COMBO.maxTime;
            
            // Update multiplier
            const newMultiplier = Math.min(this.combo, COMBO.maxMultiplier);
            if (newMultiplier > this.comboMultiplier) {
                this.comboMultiplier = newMultiplier;
                this.showComboFlash(newMultiplier);
            }
        } else {
            this.comboTimer -= 0.016; // Approximate dt
            if (this.comboTimer <= 0) {
                this.combo = 0;
                this.comboMultiplier = 1;
            }
        }
    }
    
    showComboFlash(multiplier) {
        this.comboFlashText = `x${multiplier} COMBO!`;
        this.comboFlashTimer = 1.0;
    }
    
    update(dt) {
        // Update score pop animation
        if (this.scorePopTimer > 0) {
            this.scorePopTimer -= dt;
            const progress = this.scorePopTimer / ANIMATION.scorePopDuration;
            this.scorePopScale = 1 + (1 - progress) * (ANIMATION.scorePopScale - 1);
        } else {
            this.scorePopScale = 1;
        }
        
        // Update combo timer
        if (this.comboTimer > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.combo = 0;
                this.comboMultiplier = 1;
            }
        }
        
        // Update combo flash text
        if (this.comboFlashTimer > 0) {
            this.comboFlashTimer -= dt;
        }
    }
    
    setLevel(level) {
        this.level = level;
    }
    
    setLives(lives) {
        this.lives = lives;
    }
    
    draw(ctx) {
        this.drawScore(ctx);
        this.drawLevel(ctx);
        this.drawLives(ctx);
        this.drawShieldBar(ctx);
        this.drawCombo(ctx);
        this.drawComboFlash(ctx);
    }
    
    drawScore(ctx) {
        ctx.save();
        
        // Glow effect
        ctx.shadowBlur = ANIMATION.glowBlur;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = 'bold 20px Courier New';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        // Apply pop scale
        ctx.translate(20, 20);
        ctx.scale(this.scorePopScale, this.scorePopScale);
        
        ctx.fillText(`SCORE: ${this.score.toString().padStart(6, '0')}`, 0, 0);
        
        ctx.restore();
    }
    
    drawLevel(ctx) {
        ctx.save();
        
        ctx.shadowBlur = ANIMATION.glowBlur;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = 'bold 20px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        
        ctx.fillText(`LEVEL ${this.level}`, CANVAS_WIDTH / 2, 20);
        
        ctx.restore();
    }
    
    drawLives(ctx) {
        ctx.save();
        
        ctx.shadowBlur = ANIMATION.glowBlur;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = 'bold 20px Courier New';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        
        ctx.fillText(`LIVES: ${this.lives}`, CANVAS_WIDTH - 20, 20);
        
        ctx.restore();
    }
    
    drawShieldBar(ctx) {
        const barWidth = 100;
        const barHeight = 10;
        const barX = CANVAS_WIDTH / 2 - barWidth / 2;
        const barY = 55;
        
        // Background
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(barX - 2, barY - 2, barWidth + 4, barHeight + 4);
        
        // Gradient fill
        const gradient = ctx.createLinearGradient(barX, barY, barX + barWidth, barY);
        gradient.addColorStop(0, COLORS.shieldBarStart);
        gradient.addColorStop(1, COLORS.shieldBarEnd);
        
        ctx.fillStyle = gradient;
        const fillWidth = (this.lives / PLAYER.shieldMax) * barWidth;
        ctx.fillRect(barX, barY, fillWidth, barHeight);
        
        // Border
        ctx.strokeStyle = COLORS.hudText;
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, barWidth, barHeight);
        
        ctx.restore();
        
        // Label
        ctx.save();
        ctx.shadowBlur = ANIMATION.glowBlur;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '12px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SHIELD', CANVAS_WIDTH / 2, barY + barHeight + 12);
        
        ctx.restore();
    }
    
    drawCombo(ctx) {
        if (this.combo <= 1) return;
        
        ctx.save();
        
        const alpha = Math.min(1, this.comboTimer / 0.5);
        ctx.globalAlpha = alpha;
        
        ctx.shadowBlur = ANIMATION.glowBlur;
        ctx.shadowColor = COLORS.powerup;
        
        ctx.fillStyle = COLORS.powerup;
        ctx.font = 'bold 16px Courier New';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        
        ctx.fillText(`x${this.comboMultiplier} COMBO`, CANVAS_WIDTH - 20, 50);
        
        ctx.restore();
    }
    
    drawComboFlash(ctx) {
        if (this.comboFlashTimer <= 0) return;
        
        ctx.save();
        
        const alpha = this.comboFlashTimer;
        ctx.globalAlpha = alpha;
        
        // Glow effect
        ctx.shadowBlur = 30;
        ctx.shadowColor = COLORS.powerup;
        
        ctx.fillStyle = COLORS.powerup;
        ctx.font = 'bold 48px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        ctx.fillText(this.comboFlashText, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 50);
        
        ctx.restore();
    }
    
    getScore() {
        return this.score;
    }
    
    getHighScore() {
        return this.highScore;
    }
}

export default HUD;
