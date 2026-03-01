// Neon Invaders - HUD (Heads-Up Display)
// Score, lives, level, shield bar, combo display

import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, GLOW, GAME } from './config.js';

export class HUD {
  constructor() {
    this.score = 0;
    this.highScore = this.loadHighScore();
    this.level = 1;
    this.lives = 1; // Player has one ship
    this.combo = 0;
    this.comboTimer = 0;
    this.comboDisplayTime = 0;
    this.scorePopTime = 0;
    this.shield = 0;
    this.shieldMax = 3;
    
    // Power-up effect timers
    this.rapidFireTime = 0;
    this.spreadShotTime = 0;
  }

  loadHighScore() {
    const saved = localStorage.getItem('neonInvadersHighScore');
    return saved ? parseInt(saved, 10) : 0;
  }

  saveHighScore() {
    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem('neonInvadersHighScore', this.highScore.toString());
    }
  }

  reset() {
    this.score = 0;
    this.level = 1;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboDisplayTime = 0;
    this.scorePopTime = 0;
    this.rapidFireTime = 0;
    this.spreadShotTime = 0;
  }

  addScore(basePoints, comboMultiplier) {
    const points = basePoints * comboMultiplier;
    this.score += points;
    this.scorePopTime = GAME.scorePopTime;
    this.saveHighScore();
  }

  updateCombo(killed) {
    if (killed) {
      this.combo++;
      if (this.combo > 5) this.combo = 5; // Max combo
      this.comboTimer = 1.5; // Reset timer
      this.comboDisplayTime = 0.8; // Show combo text
    } else {
      this.comboTimer -= 0.016; // Approximate dt
      if (this.comboTimer <= 0) {
        this.combo = 0;
      }
    }
  }

  update(dt) {
    // Update combo timer
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
      }
    }
    
    // Update combo display time
    if (this.comboDisplayTime > 0) {
      this.comboDisplayTime -= dt;
    }
    
    // Update score pop animation
    if (this.scorePopTime > 0) {
      this.scorePopTime -= dt;
    }
    
    // Update power-up timers
    if (this.rapidFireTime > 0) this.rapidFireTime -= dt;
    if (this.spreadShotTime > 0) this.spreadShotTime -= dt;
  }

  draw(ctx) {
    this.drawScore(ctx);
    this.drawLevel(ctx);
    this.drawShieldBar(ctx);
    this.drawCombo(ctx);
    this.drawPowerupTimers(ctx);
  }

  drawScore(ctx) {
    ctx.save();
    
    // Score pop effect
    let scale = 1;
    if (this.scorePopTime > 0) {
      scale = 1 + (this.scorePopTime / GAME.scorePopTime) * 0.3;
    }
    
    ctx.translate(20, 20);
    ctx.scale(scale, scale);
    
    // Glow effect
    ctx.shadowBlur = GLOW.mainShadowBlur;
    ctx.shadowColor = COLORS.hudText;
    
    // Score label
    ctx.fillStyle = COLORS.hudText;
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('SCORE', 0, 0);
    
    // Score value
    ctx.font = 'bold 24px monospace';
    ctx.fillText(this.score.toString().padStart(6, '0'), 0, 20);
    
    // High score (smaller, below)
    ctx.shadowBlur = 0;
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(0, 255, 245, 0.6)';
    ctx.fillText('HI: ' + this.highScore.toString().padStart(6, '0'), 0, 50);
    
    ctx.restore();
  }

  drawLevel(ctx) {
    ctx.save();
    
    ctx.shadowBlur = GLOW.mainShadowBlur;
    ctx.shadowColor = COLORS.hudText;
    
    ctx.fillStyle = COLORS.hudText;
    ctx.font = '14px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    
    ctx.fillText('LEVEL ' + this.level, CANVAS_WIDTH - 20, 20);
    
    ctx.restore();
  }

  drawShieldBar(ctx) {
    const barWidth = 150;
    const barHeight = 12;
    const barX = CANVAS_WIDTH / 2 - barWidth / 2;
    const barY = 15;
    
    ctx.save();
    
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(barX - 2, barY - 2, barWidth + 4, barHeight + 4);
    
    // Shield segments
    const segmentWidth = (barWidth - 10) / this.shieldMax;
    
    for (let i = 0; i < this.shieldMax; i++) {
      const x = barX + i * (segmentWidth + 5);
      const isActive = i < this.shield;
      
      if (isActive) {
        // Gradient fill for active shields
        const gradient = ctx.createLinearGradient(x, barY, x + segmentWidth, barY);
        gradient.addColorStop(0, COLORS.shieldBar[0]);
        gradient.addColorStop(1, COLORS.shieldBar[1]);
        
        ctx.shadowBlur = GLOW.mainShadowBlur;
        ctx.shadowColor = COLORS.shieldBar[0];
        ctx.fillStyle = gradient;
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      }
      
      // Draw shield segment
      ctx.fillRect(x, barY, segmentWidth, barHeight);
    }
    
    // Shield label
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.hudText;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('SHIELD', CANVAS_WIDTH / 2, barY - 4);
    
    ctx.restore();
  }

  drawCombo(ctx) {
    if (this.combo <= 1) return;
    
    ctx.save();
    
    // Fade out effect
    const alpha = this.comboDisplayTime > 0 
      ? Math.min(1, this.comboDisplayTime / 0.3)
      : 1;
    
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = GLOW.glowShadowBlur;
    ctx.shadowColor = COLORS.comboText;
    
    ctx.fillStyle = COLORS.comboText;
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const text = 'x' + this.combo + ' COMBO!';
    const textWidth = ctx.measureText(text).width;
    
    ctx.fillText(text, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 100);
    
    ctx.restore();
  }

  drawPowerupTimers(ctx) {
    const now = performance.now();
    
    // Rapid fire timer
    if (this.rapidFireTime > 0) {
      this.drawPowerupIndicator(ctx, 'RAPID', this.rapidFireTime, '#ff6600', 20);
    }
    
    // Spread shot timer
    if (this.spreadShotTime > 0) {
      this.drawPowerupIndicator(ctx, 'SPREAD', this.spreadShotTime, '#ff00ff', 50);
    }
  }

  drawPowerupIndicator(ctx, label, time, color, yOffset) {
    ctx.save();
    
    const barWidth = 100;
    const barHeight = 6;
    const x = CANVAS_WIDTH / 2 - barWidth / 2;
    const y = CANVAS_HEIGHT - 60 + yOffset;
    
    // Label
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, CANVAS_WIDTH / 2, y - 12);
    
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x, y, barWidth, barHeight);
    
    // Fill
    const fillWidth = (time / 8) * barWidth; // 8 seconds max
    ctx.shadowBlur = GLOW.mainShadowBlur;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, fillWidth, barHeight);
    
    ctx.restore();
  }

  // Set power-up timers (called when power-up is collected)
  setRapidFireTime(time) {
    this.rapidFireTime = time / 1000; // Convert ms to seconds
  }

  setSpreadShotTime(time) {
    this.spreadShotTime = time / 1000; // Convert ms to seconds
  }

  // Getters for game logic
  getComboMultiplier() {
    return Math.max(1, this.combo);
  }

  isRapidFireActive() {
    return this.rapidFireTime > 0;
  }

  isSpreadShotActive() {
    return this.spreadShotTime > 0;
  }
}

export default HUD;
