// HUD - Score, lives, level, shield bar, combo display
import { CONFIG } from './config.js';

export class HUD {
    constructor() {
        this.score = 0;
        this.highScore = this.loadHighScore();
        this.lives = CONFIG.SHIELD_MAX;
        this.level = 1;
        this.combo = 0;
        this.comboMultiplier = 1;
        this.lastScore = 0;
        this.scorePopTime = 0;
        this.comboText = '';
        this.comboTextTime = 0;
        this.shieldFlashTime = 0;
    }
    
    loadHighScore() {
        const saved = localStorage.getItem(CONFIG.HIGHSCORE_KEY);
        return saved ? parseInt(saved, 10) : 0;
    }
    
    saveHighScore() {
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem(CONFIG.HIGHSCORE_KEY, this.highScore.toString());
        }
    }
    
    addScore(basePoints, multiplier) {
        const points = basePoints * multiplier;
        this.score += points;
        this.lastScore = points;
        this.scorePopTime = CONFIG.SCORE_POP_TIME;
        
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem(CONFIG.HIGHSCORE_KEY, this.highScore.toString());
        }
    }
    
    updateCombo() {
        if (this.combo > 1) {
            this.comboText = `x${this.combo} COMBO!`;
            this.comboTextTime = CONFIG.COMBO_TEXT_TIME;
        }
    }
    
    resetCombo() {
        this.combo = 0;
        this.comboMultiplier = 1;
        this.comboText = '';
    }
    
    incrementCombo() {
        if (this.combo < CONFIG.MAX_COMBO) {
            this.combo++;
            this.comboMultiplier = this.combo;
        } else {
            this.comboMultiplier = CONFIG.MAX_COMBO;
        }
        this.updateCombo();
    }
    
    update(dt) {
        if (this.scorePopTime > 0) {
            this.scorePopTime -= dt;
        }
        if (this.comboTextTime > 0) {
            this.comboTextTime -= dt;
            if (this.comboTextTime <= 0) {
                this.comboText = '';
            }
        }
        if (this.shieldFlashTime > 0) {
            this.shieldFlashTime -= dt;
        }
    }
    
    hit() {
        this.lives--;
        this.shieldFlashTime = CONFIG.SHIELD_FLASH_TIME;
        this.resetCombo();
    }
    
    addShield() {
        if (this.lives < CONFIG.SHIELD_MAX) {
            this.lives++;
            return true;
        }
        return false;
    }
    
    setLevel(level) {
        this.level = level;
    }
    
    draw(ctx) {
        ctx.font = '16px Courier New';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        // Score with pop animation
        const scale = this.scorePopTime > 0 ? 1 + this.scorePopTime / CONFIG.SCORE_POP_TIME : 1;
        ctx.save();
        ctx.translate(20, 10);
        ctx.scale(scale, scale);
        ctx.fillStyle = CONFIG.COLORS.PLAYER;
        ctx.shadowBlur = 10;
        ctx.shadowColor = CONFIG.COLORS.PLAYER;
        ctx.fillText(`SCORE: ${this.score}`, 0, 0);
        ctx.restore();
        
        // High score
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.fillText(`HI: ${this.highScore}`, 20, 30);
        
        // Level
        ctx.fillStyle = CONFIG.COLORS.PLAYER;
        ctx.shadowBlur = 10;
        ctx.shadowColor = CONFIG.COLORS.PLAYER;
        ctx.fillText(`LEVEL: ${this.level}`, CONFIG.CANVAS_WIDTH / 2 - 40, 10);
        
        // Shield bar
        this.drawShieldBar(ctx);
        
        // Combo display
        if (this.comboTextTime > 0) {
            this.drawCombo(ctx);
        }
    }
    
    drawShieldBar(ctx) {
        const barWidth = 150;
        const barHeight = 12;
        const x = CONFIG.CANVAS_WIDTH - barWidth - 20;
        const y = 10;
        
        // Background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(x, y, barWidth, barHeight);
        
        // Shield segments
        const segmentWidth = barWidth / CONFIG.SHIELD_MAX;
        for (let i = 0; i < CONFIG.SHIELD_MAX; i++) {
            const alpha = this.shieldFlashTime > 0 && i >= this.lives ? 
                (Math.sin(Date.now() / 50) > 0 ? 0.3 : 1) : 1;
            
            if (i < this.lives) {
                // Gradient from cyan to magenta
                const gradient = ctx.createLinearGradient(x + i * segmentWidth, y, x + (i + 1) * segmentWidth, y);
                gradient.addColorStop(0, CONFIG.COLORS.PLAYER);
                gradient.addColorStop(1, CONFIG.COLORS.ENEMY_A);
                
                ctx.globalAlpha = alpha;
                ctx.shadowBlur = 10;
                ctx.shadowColor = CONFIG.COLORS.PLAYER;
                ctx.fillStyle = gradient;
                ctx.fillRect(x + i * segmentWidth + 1, y + 1, segmentWidth - 2, barHeight - 2);
                ctx.globalAlpha = 1;
            }
        }
        
        ctx.shadowBlur = 0;
        
        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px Courier New';
        ctx.textAlign = 'right';
        ctx.fillText('SHIELD', x - 10, y + barHeight / 2 + 4);
    }
    
    drawCombo(ctx) {
        ctx.save();
        ctx.translate(CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
        
        const scale = 1 + Math.sin(this.comboTextTime * 5) * 0.2;
        ctx.scale(scale, scale);
        
        const text = this.comboText;
        const width = ctx.measureText(text).width;
        
        ctx.font = 'bold 48px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Glow
        ctx.shadowBlur = 20;
        ctx.shadowColor = CONFIG.COLORS.POWERUP;
        ctx.fillStyle = CONFIG.COLORS.COMBO_TEXT;
        ctx.fillText(text, 0, 0);
        
        ctx.restore();
    }
    
    drawGameOver(ctx) {
        ctx.save();
        
        // Flash effect
        ctx.fillStyle = `rgba(255, 255, 255, ${this.shieldFlashTime})`;
        ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Game Over text
        ctx.font = 'bold 64px Courier New';
        ctx.shadowBlur = 30;
        ctx.shadowColor = CONFIG.COLORS.ENEMY_A;
        ctx.fillStyle = CONFIG.COLORS.ENEMY_A;
        ctx.fillText('GAME OVER', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 60);
        
        // Final score
        ctx.shadowBlur = 10;
        ctx.shadowColor = CONFIG.COLORS.PLAYER;
        ctx.fillStyle = CONFIG.COLORS.PLAYER;
        ctx.font = '32px Courier New';
        ctx.fillText(`Final Score: ${this.score}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 10);
        
        // Level reached
        ctx.fillStyle = '#ffffff';
        ctx.font = '24px Courier New';
        ctx.fillText(`Level: ${this.level}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 50);
        
        // Restart prompt
        ctx.font = '20px Courier New';
        ctx.fillStyle = '#00fff5';
        ctx.fillText('Press ENTER to restart', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 100);
        
        ctx.restore();
    }
    
    drawLevelTransition(ctx, levelManager) {
        ctx.save();

        const transitionTime = levelManager.transitionTime;
        const message = levelManager.transitionMessage || `LEVEL ${levelManager.getCurrentLevel()}`;

        // Fade effect
        const alpha = Math.sin((CONFIG.LEVEL_TRANSITION_TIME - transitionTime) / CONFIG.LEVEL_TRANSITION_TIME * Math.PI);
        ctx.fillStyle = `rgba(0, 0, 0, ${1 - alpha})`;
        ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

        ctx.fillStyle = CONFIG.COLORS.PLAYER;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 64px Courier New';
        ctx.shadowBlur = 30;
        ctx.shadowColor = CONFIG.COLORS.PLAYER;
        ctx.fillText(message, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);

        ctx.restore();
    }
    
    reset() {
        this.score = 0;
        this.lives = CONFIG.SHIELD_MAX;
        this.level = 1;
        this.resetCombo();
        this.scorePopTime = 0;
        this.comboTextTime = 0;
        this.shieldFlashTime = 0;
    }
}