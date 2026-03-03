// Main Game Entry Point - Game Loop, State Machine, Module Integration

import { CANVAS_WIDTH, CANVAS_HEIGHT, STATES, PLAYER, HIGH_SCORE_KEY, COLORS } from './config.js';
import InputHandler from './input.js';
import Background from './background.js';
import ParticleSystem from './particles.js';
import Player from './player.js';
import EnemyGrid from './enemies.js';
import ProjectileManager from './projectiles.js';
import PowerUpManager from './powerups.js';
import LevelManager from './levels.js';
import HUD from './hud.js';
import audio from './audio.js';
import { checkCollision } from './collision.js';

class Game {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Initialize systems
        this.input = new InputHandler();
        this.background = new Background();
        this.particles = new ParticleSystem();
        this.player = new Player(0, 0);
        this.enemyGrid = new EnemyGrid();
        this.projectiles = new ProjectileManager();
        this.powerups = new PowerUpManager();
        this.levelManager = new LevelManager();
        this.hud = new HUD();
        
        // Game state
        this.state = STATES.MENU;
        this.time = 0;
        this.lastTime = 0;
        
        // Bind methods
        this.loop = this.loop.bind(this);
        
        // Start the game loop
        requestAnimationFrame(this.loop);
    }
    
    startGame() {
        this.hud.reset();
        this.levelManager.startLevel(1);
        this.player.reset(CANVAS_WIDTH / 2 - PLAYER.width / 2, CANVAS_HEIGHT - 60);
        this.enemyGrid.spawn(1);
        this.projectiles.clear();
        this.powerups.clear();
        this.particles.clear();
        this.state = STATES.PLAYING;
        audio.playLevelComplete();
    }
    
    restartGame() {
        this.startGame();
    }
    
    update(dt) {
        this.time += dt;
        
        switch (this.state) {
            case STATES.MENU:
                this.updateMenu(dt);
                break;
                
            case STATES.PLAYING:
                this.updatePlaying(dt);
                break;
                
            case STATES.LEVEL_TRANSITION:
                this.updateLevelTransition(dt);
                break;
                
            case STATES.GAME_OVER:
                this.updateGameOver(dt);
                break;
        }
        
        this.background.update(dt, this.time);
        this.particles.update(dt);
    }
    
    updateMenu(dt) {
        // Update background for visual interest
        
        // Start game on Enter
        if (this.input.isStarting()) {
            audio.resume();
            this.startGame();
        }
    }
    
    updatePlaying(dt) {
        // Update player
        this.player.update(dt, this.input, this.particles);
        
        // Update enemy grid
        const allDestroyed = this.enemyGrid.update(dt, this.time, this.levelManager.getCurrentLevel());
        
        // Check if all enemies destroyed
        if (allDestroyed) {
            this.levelManager.nextLevel();
            this.state = STATES.LEVEL_TRANSITION;
            audio.playLevelComplete();
            return;
        }
        
        // Update projectiles
        this.projectiles.update(dt);
        
        // Update power-ups
        this.powerups.update(dt);
        
        // Check player bullet collisions with enemies
        const playerBullets = this.player.getBulletRects();
        const hits = this.enemyGrid.checkBulletCollisions(playerBullets);
        
        hits.forEach(hit => {
            // Remove hit bullet
            if (hit.bulletIndex < playerBullets.length) {
                this.player.bullets.splice(hit.bulletIndex, 1);
            }
            
            // Create explosion
            const enemy = hit.enemy;
            this.particles.createExplosion(
                enemy.x + enemy.width / 2,
                enemy.y + enemy.height / 2,
                enemy.color
            );
            
            // Add score with combo
            this.hud.addScore(hit.points);
            this.hud.updateCombo(true);
            
            // Spawn power-up
            this.powerups.spawn(
                enemy.x + enemy.width / 2,
                enemy.y + enemy.height / 2
            );
        });
        
        // Check enemy bullet collisions with player
        const enemyBullets = this.projectiles.getEnemyProjectiles();
        const playerRect = {
            x: this.player.x,
            y: this.player.y,
            width: this.player.width,
            height: this.player.height
        };
        
        for (let i = enemyBullets.length - 1; i >= 0; i--) {
            const bullet = enemyBullets[i];
            const bulletRect = bullet.getRect();
            
            if (checkCollision(playerRect, bulletRect)) {
                // Remove bullet
                this.projectiles.getAllProjectiles().splice(
                    this.projectiles.getAllProjectiles().indexOf(bullet), 1
                );
                
                // Create impact effect
                this.particles.createImpact(bullet.x, bullet.y, COLORS.enemyBullet);
                
                // Damage player
                if (this.player.takeDamage()) {
                    this.triggerGameOver();
                } else {
                    audio.playPlayerHit();
                    this.hud.setLives(this.player.shield);
                }
                
                break;
            }
        }
        
        // Check power-up collection
        const powerupType = this.powerups.checkPlayerCollision(this.player);
        if (powerupType) {
            this.player.applyPowerup(powerupType);
            this.particles.createPowerupCollect(
                this.player.x + this.player.width / 2,
                this.player.y + this.player.height / 2
            );
            audio.playPowerupCollect();
        }
        
        // Check enemy collision with player
        if (this.enemyGrid.checkPlayerCollision(this.player)) {
            if (this.player.takeDamage()) {
                this.triggerGameOver();
            } else {
                audio.playPlayerHit();
                this.hud.setLives(this.player.shield);
            }
        }
        
        // Check if enemies reached player row
        if (this.enemyGrid.getBottomEdge() >= this.player.y) {
            this.triggerGameOver();
        }
        
        // Update HUD
        this.hud.update(dt);
        this.hud.updateCombo(false); // Decrement combo timer
    }
    
    updateLevelTransition(dt) {
        const complete = this.levelManager.update(dt);
        
        if (complete) {
            this.state = STATES.PLAYING;
            this.player.reset(CANVAS_WIDTH / 2 - PLAYER.width / 2, CANVAS_HEIGHT - 60);
            this.enemyGrid.spawn(this.levelManager.getCurrentLevel());
            this.projectiles.clear();
            this.powerups.clear();
            this.hud.setLevel(this.levelManager.getCurrentLevel());
        }
    }
    
    updateGameOver(dt) {
        if (this.input.isStarting()) {
            this.restartGame();
        }
    }
    
    triggerGameOver() {
        this.state = STATES.GAME_OVER;
        audio.playGameOver();
        this.particles.createExplosion(
            this.player.x + this.player.width / 2,
            this.player.y + this.player.height / 2,
            COLORS.player
        );
    }
    
    draw() {
        // Clear canvas
        this.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        
        // Draw background
        this.background.draw(this.ctx);
        
        switch (this.state) {
            case STATES.MENU:
                this.drawMenu();
                break;
                
            case STATES.PLAYING:
                this.drawPlaying();
                break;
                
            case STATES.LEVEL_TRANSITION:
                this.drawPlaying();
                this.levelManager.drawTransition(this.ctx);
                break;
                
            case STATES.GAME_OVER:
                this.drawGameOver();
                break;
        }
        
        // Draw particles
        this.particles.draw(this.ctx);
    }
    
    drawMenu() {
        const ctx = this.ctx;
        
        // Draw title with glow
        ctx.save();
        ctx.shadowBlur = 30;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = 'bold 64px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEON INVADERS', CANVAS_WIDTH / 2, 200);
        
        ctx.restore();
        
        // Draw subtitle
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '20px Courier New';
        ctx.fillText('Press ENTER to Start', CANVAS_WIDTH / 2, 280);
        
        ctx.restore();
        
        // Draw high score
        ctx.save();
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '16px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(`HIGH SCORE: ${this.hud.getHighScore().toString().padStart(6, '0')}`, CANVAS_WIDTH / 2, 340);
        ctx.restore();
        
        // Draw controls hint
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '14px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText('Arrow Keys / A-D to Move', CANVAS_WIDTH / 2, 420);
        ctx.fillText('Space to Shoot', CANVAS_WIDTH / 2, 445);
        ctx.restore();
    }
    
    drawPlaying() {
        // Draw enemies
        this.enemyGrid.draw(this.ctx, this.time);
        
        // Draw player
        this.player.draw(this.ctx);
        
        // Draw projectiles
        this.projectiles.draw(this.ctx);
        
        // Draw power-ups
        this.powerups.draw(this.ctx);
        
        // Draw HUD
        this.hud.draw(this.ctx);
    }
    
    drawGameOver() {
        // Flash effect
        const ctx = this.ctx;
        
        // Draw semi-transparent overlay
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.restore();
        
        // Draw "GAME OVER" text
        ctx.save();
        ctx.shadowBlur = 30;
        ctx.shadowColor = '#ff0000';
        
        ctx.fillStyle = '#ff0000';
        ctx.font = 'bold 64px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GAME OVER', CANVAS_WIDTH / 2, 200);
        
        ctx.restore();
        
        // Draw final score
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '24px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(`FINAL SCORE: ${this.hud.getScore().toString().padStart(6, '0')}`, CANVAS_WIDTH / 2, 280);
        
        ctx.restore();
        
        // Draw high score
        ctx.save();
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '18px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(`HIGH SCORE: ${this.hud.getHighScore().toString().padStart(6, '0')}`, CANVAS_WIDTH / 2, 330);
        
        ctx.restore();
        
        // Draw level reached
        ctx.save();
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '18px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(`LEVEL REACHED: ${this.levelManager.getCurrentLevel()}`, CANVAS_WIDTH / 2, 370);
        
        ctx.restore();
        
        // Draw restart prompt
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = COLORS.hudText;
        
        ctx.fillStyle = COLORS.hudText;
        ctx.font = '20px Courier New';
        ctx.fillText('Press ENTER to Restart', CANVAS_WIDTH / 2, 450);
        
        ctx.restore();
    }
    
    loop(currentTime) {
        // Calculate delta time
        const dt = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        
        // Cap delta time to prevent huge jumps
        const cappedDt = Math.min(dt, 0.1);
        
        // Update and draw
        this.update(cappedDt);
        this.draw();
        
        // Continue loop
        requestAnimationFrame(this.loop);
    }
}

// Initialize game when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    new Game();
});
