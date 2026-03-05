// Main - Game loop, state machine, entry point
import { CONFIG } from './config.js';
import { InputHandler } from './input.js';
import { AudioHandler } from './audio.js';
import { Background } from './background.js';
import { ParticleSystem } from './particles.js';
import { ProjectileManager } from './projectiles.js';
import { EnemyGrid } from './enemies.js';
import { Player } from './player.js';
import { PowerUpManager } from './powerups.js';
import { LevelManager } from './levels.js';
import { HUD } from './hud.js';
import { checkCollision } from './collision.js';

// Game states
const STATE = {
    MENU: 'menu',
    PLAYING: 'playing',
    LEVEL_TRANSITION: 'levelTransition',
    GAME_OVER: 'gameOver'
};

class Game {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Initialize systems
        this.input = new InputHandler();
        this.audio = new AudioHandler();
        this.background = new Background(CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
        this.particles = new ParticleSystem();
        this.projectiles = new ProjectileManager();
        this.enemies = new EnemyGrid();
        this.player = new Player(
            CONFIG.CANVAS_WIDTH / 2 - CONFIG.PLAYER_WIDTH / 2,
            CONFIG.CANVAS_HEIGHT - 60
        );
        this.powerups = new PowerUpManager();
        this.levelManager = new LevelManager();
        this.hud = new HUD();
        
        // Game state
        this.state = STATE.MENU;
        this.lastTime = 0;
        this.comboTimer = 0;
        this.flashTime = 0;
        
        // Bind methods
        this.loop = this.loop.bind(this);
        
        // Handle window focus
        window.addEventListener('focus', () => {
            this.audio.enable();
        });
    }
    
    start() {
        this.lastTime = performance.now();
        requestAnimationFrame(this.loop);
    }
    
    loop(currentTime) {
        const dt = Math.min((currentTime - this.lastTime) / 1000, 0.05);
        this.lastTime = currentTime;
        
        this.update(dt);
        this.draw();
        
        requestAnimationFrame(this.loop);
    }
    
    update(dt) {
        // Update background
        this.background.update(dt);
        
        switch (this.state) {
            case STATE.MENU:
                this.updateMenu(dt);
                break;
            case STATE.PLAYING:
                this.updatePlaying(dt);
                break;
            case STATE.LEVEL_TRANSITION:
                this.updateLevelTransition(dt);
                break;
            case STATE.GAME_OVER:
                this.updateGameOver(dt);
                break;
        }
        
        // Update particles
        this.particles.update(dt);
        
        // Update flash
        if (this.flashTime > 0) {
            this.flashTime -= dt;
        }
    }
    
    updateMenu(dt) {
        if (this.input.isStart()) {
            this.audio.enable();
            this.audio.playLevelComplete();
            this.startGame();
        }
    }
    
    startGame() {
        this.hud.reset();
        this.levelManager.startInitialLevel();
        this.player.reset();
        this.projectiles.clear();
        this.particles.clear();
        this.powerups.clear();
        this.comboTimer = 0;
        
        this.enemies.spawn(1);
        this.state = STATE.LEVEL_TRANSITION;
    }
    
    updatePlaying(dt) {
        // Update player
        this.player.update(dt, this.input);
        
        // Player shooting
        if (this.input.isShoot() && this.player.shoot()) {
            this.audio.playShoot();
            
            const bulletX = this.player.x + this.player.width / 2;
            const bulletY = this.player.y;
            
            if (this.player.hasSpreadShot()) {
                this.projectiles.createSpreadBullets(bulletX, bulletY);
            } else {
                this.projectiles.createPlayerBullet(bulletX, bulletY);
            }
        }
        
        // Update projectiles
        this.projectiles.update(dt);
        
        // Update enemies
        const level = this.levelManager.getCurrentLevel();
        this.enemies.update(dt, level);
        
        // Enemy shooting (consume queued shooter from timer)
        const shooter = this.enemies.consumeShooter();
        if (shooter) {
            this.audio.playEnemyShoot();
            this.projectiles.createEnemyBullet(
                shooter.x + CONFIG.ENEMY_WIDTH / 2,
                shooter.y
            );
        }
        
        // Update power-ups
        this.powerups.update(dt);
        
        // Update combo timer
        if (this.comboTimer > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.hud.resetCombo();
            }
        }
        
        // Check collisions
        this.checkCollisions();
        
        // Check level complete
        if (this.enemies.isCleared()) {
            this.audio.playLevelComplete();
            this.levelManager.startNextLevel();
            this.state = STATE.LEVEL_TRANSITION;
            this.hud.setLevel(this.levelManager.getCurrentLevel());
        }
        
        // Check if enemies reached player
        if (this.enemies.reachesPlayerRow(this.player.y)) {
            this.gameOver();
        }
        
        // Update HUD
        this.hud.update(dt);
    }
    
    updateLevelTransition(dt) {
        if (this.levelManager.update(dt)) {
            // Transition complete, spawn next wave
            this.enemies.spawn(this.levelManager.getCurrentLevel());
            this.state = STATE.PLAYING;
        }
    }
    
    updateGameOver(dt) {
        if (this.input.isRestart()) {
            this.hud.reset();
            this.levelManager.startInitialLevel();
            this.player.reset();
            this.projectiles.clear();
            this.particles.clear();
            this.powerups.clear();
            this.comboTimer = 0;
            this.enemies.spawn(1);
            this.state = STATE.LEVEL_TRANSITION;
        }
    }
    
    checkCollisions() {
        const playerBounds = this.player.getBounds();
        
        // Player bullets vs enemies
        const playerProjectiles = this.projectiles.getPlayerProjectiles();
        for (let i = playerProjectiles.length - 1; i >= 0; i--) {
            const bullet = playerProjectiles[i];
            const bulletBounds = bullet.getBounds();
            
            for (const enemy of this.enemies.enemies) {
                if (!enemy.active) continue;
                
                const enemyBounds = enemy.getBounds();
                if (checkCollision(bulletBounds, enemyBounds)) {
                    bullet.active = false;
                    this.particles.createImpact(
                        bullet.x, bullet.y, bullet.color
                    );
                    
                    const destroyed = this.enemies.hitEnemy(enemy);
                    if (destroyed) {
                        this.audio.playEnemyDestroyed();
                        this.particles.createExplosion(
                            enemy.x + CONFIG.ENEMY_WIDTH / 2,
                            enemy.y + CONFIG.ENEMY_HEIGHT / 2,
                            enemy.color
                        );
                        
                        // Add score with combo
                        this.hud.incrementCombo();
                        this.hud.addScore(enemy.points, this.hud.comboMultiplier);
                        this.comboTimer = CONFIG.COMBO_WINDOW;
                        
                        // Drop power-up
                        this.powerups.createDrop(
                            enemy.x + CONFIG.ENEMY_WIDTH / 2,
                            enemy.y + CONFIG.ENEMY_HEIGHT / 2
                        );
                    }
                    break;
                }
            }
        }
        
        // Enemy bullets vs player
        const enemyProjectiles = this.projectiles.getEnemyProjectiles();
        for (const bullet of enemyProjectiles) {
            const bulletBounds = bullet.getBounds();
            if (checkCollision(bulletBounds, playerBounds)) {
                if (!this.player.isInvulnerable()) {
                    bullet.active = false;
                    this.particles.createImpact(
                        bullet.x, bullet.y, bullet.color
                    );
                    
                    this.audio.playPlayerHit();
                    this.hud.hit();
                    if (this.player.hit()) {
                        this.gameOver();
                    }
                }
            }
        }

        // Player vs power-ups
        const activePowerups = this.powerups.getActive();
        for (const powerup of activePowerups) {
            const powerupBounds = powerup.getBounds();
            if (checkCollision(playerBounds, powerupBounds)) {
                powerup.collect();
                this.audio.playPowerupCollect();
                this.particles.createPowerupCollect(
                    powerup.x + CONFIG.POWERUP_WIDTH / 2,
                    powerup.y + CONFIG.POWERUP_HEIGHT / 2
                );
                
                // Apply power-up effect
                switch (powerup.type) {
                    case 'R':
                        this.player.activateRapidFire();
                        break;
                    case 'S':
                        this.player.addShield();
                        this.hud.addShield();
                        break;
                    case 'W':
                        this.player.activateSpreadShot();
                        break;
                }
            }
        }
        
        // Enemy collisions with player
        for (const enemy of this.enemies.enemies) {
            if (!enemy.active) continue;
            
            const enemyBounds = enemy.getBounds();
            if (checkCollision(enemyBounds, playerBounds)) {
                if (!this.player.isInvulnerable()) {
                    this.particles.createExplosion(
                        enemy.x + CONFIG.ENEMY_WIDTH / 2,
                        enemy.y + CONFIG.ENEMY_HEIGHT / 2,
                        enemy.color
                    );
                    enemy.active = false;
                    
                    if (this.player.hit()) {
                        this.audio.playPlayerHit();
                        this.hud.hit();
                        this.gameOver();
                    }
                }
            }
        }
    }
    
    gameOver() {
        this.audio.playGameOver();
        this.hud.saveHighScore();
        this.flashTime = 0.3;
        this.state = STATE.GAME_OVER;
    }
    
    draw() {
        // Clear canvas
        this.ctx.fillStyle = CONFIG.COLORS.BACKGROUND;
        this.ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
        
        // Draw background
        this.background.draw(this.ctx);
        
        switch (this.state) {
            case STATE.MENU:
                this.drawMenu();
                break;
            case STATE.PLAYING:
                this.drawPlaying();
                break;
            case STATE.LEVEL_TRANSITION:
                this.drawPlaying();
                this.hud.drawLevelTransition(this.ctx, this.levelManager);
                break;
            case STATE.GAME_OVER:
                this.drawPlaying();
                this.hud.drawGameOver(this.ctx);
                break;
        }
        
        // Draw flash
        if (this.flashTime > 0) {
            this.ctx.fillStyle = `rgba(255, 255, 255, ${this.flashTime})`;
            this.ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
        }
    }
    
    drawMenu() {
        this.ctx.save();
        
        // Title
        this.ctx.fillStyle = CONFIG.COLORS.PLAYER;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        this.ctx.font = 'bold 72px Courier New';
        this.ctx.shadowBlur = 30;
        this.ctx.shadowColor = CONFIG.COLORS.PLAYER;
        this.ctx.fillText('NEON INVADERS', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 80);
        
        // Subtitle
        this.ctx.font = '24px Courier New';
        this.ctx.shadowBlur = 15;
        this.ctx.shadowColor = CONFIG.COLORS.ENEMY_A;
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText('A Space Invaders Tribute', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 20);
        
        // High score
        this.ctx.font = '20px Courier New';
        this.ctx.fillStyle = CONFIG.COLORS.POWERUP;
        this.ctx.shadowColor = CONFIG.COLORS.POWERUP;
        this.ctx.fillText(`HIGH SCORE: ${this.hud.highScore}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 40);
        
        // Start prompt
        const pulse = 0.5 + Math.sin(Date.now() / 300) * 0.5;
        this.ctx.globalAlpha = pulse;
        this.ctx.fillStyle = CONFIG.COLORS.PLAYER;
        this.ctx.shadowColor = CONFIG.COLORS.PLAYER;
        this.ctx.font = '24px Courier New';
        this.ctx.fillText('Press ENTER to start', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 100);
        
        // Controls
        this.ctx.globalAlpha = 0.7;
        this.ctx.font = '16px Courier New';
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowBlur = 0;
        this.ctx.fillText('Arrow Keys / A-D to move', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 140);
        this.ctx.fillText('Space to shoot', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 165);
        
        this.ctx.restore();
    }
    
    drawPlaying() {
        // Draw enemies
        this.enemies.draw(this.ctx);
        
        // Draw player
        this.player.draw(this.ctx);
        
        // Draw projectiles
        this.projectiles.draw(this.ctx);
        
        // Draw power-ups
        this.powerups.draw(this.ctx);
        
        // Draw particles
        this.particles.draw(this.ctx);
        
        // Draw HUD
        this.hud.draw(this.ctx);
    }
}

// Initialize game when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    const game = new Game();
    game.start();
});