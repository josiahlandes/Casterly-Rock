// Main Game Module - Entry Point, Game Loop, State Machine

import { CANVAS, COLORS } from './config.js';
import { input } from './input.js';
import { playerFactory } from './player.js';
import { enemyFactory } from './enemies.js';
import { projectiles } from './projectiles.js';
import { particles } from './particles.js';
import { powerUps } from './powerups.js';
import { hud } from './hud.js';
import { background } from './background.js';
import { levels } from './levels.js';
import { audio } from './audio.js';
import { checkCollision } from './collision.js';

// Game States
const STATE = {
    MENU: 'menu',
    PLAYING: 'playing',
    LEVEL_TRANSITION: 'levelTransition',
    GAME_OVER: 'gameOver'
};

class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        this.state = STATE.MENU;
        this.lastTime = 0;
        this.comboKilled = false;
        
        // Initialize game objects
        this.player = null;
        this.enemies = null;
        
        // Bind input
        this.bindInput();
        
        // Start the game loop
        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }
    
    bindInput() {
        // Menu / Game Over state transitions
        input.onKeyPress('Enter', () => {
            if (this.state === STATE.MENU) {
                this.startGame();
            } else if (this.state === STATE.GAME_OVER) {
                this.startGame();
            }
        });
    }
    
    startGame() {
        this.player = playerFactory(800 / 2 - 20, 550);
        this.enemies = enemyFactory(1);
        projectiles.clear();
        particles.clear();
        powerUps.clear();
        hud.resetCombo();
        hud.setShield(3);
        hud.setLives(3);
        hud.setScore(0);
        levels.reset();
        levels.startLevel(1);
        
        this.state = STATE.PLAYING;
        this.comboKilled = false;
    }
    
    loop(currentTime) {
        // Calculate delta time
        const deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        
        // Cap delta time to prevent huge jumps
        const dt = Math.min(deltaTime, 0.05);
        
        // Update and draw
        this.update(dt);
        this.draw();
        
        requestAnimationFrame(this.loop);
    }
    
    update(dt) {
        // Update background
        background.update(dt);
        
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
    }
    
    updateMenu(dt) {
        // Nothing to update in menu state
    }
    
    updatePlaying(dt) {
        // Update player
        this.player.update(dt, input);
        
        // Update enemies
        if (this.enemies) {
            this.enemies.update(dt);
        }
        
        // Update projectiles
        projectiles.update(dt);
        
        // Update particles
        particles.update(dt);
        
        // Update power-ups
        powerUps.update(dt);
        
        // Update levels
        if (levels.isTransitioning()) {
            if (levels.update(dt)) {
                // Transition complete, spawn next level
                this.spawnNextLevel();
            }
        }
        
        // Check if all enemies are dead
        if (this.enemies && this.enemies.isAllDead()) {
            levels.nextLevel();
        }
        
        // Collision detection
        this.handleCollisions();
        
        // Check game over conditions
        this.checkGameOver();
    }
    
    updateLevelTransition(dt) {
        if (levels.update(dt)) {
            this.spawnNextLevel();
        }
    }
    
    updateGameOver(dt) {
        // Nothing to update, waiting for restart
    }
    
    spawnNextLevel() {
        const level = levels.getCurrentLevel();
        this.enemies = enemyFactory(level);
        hud.setLevel(level);
        this.comboKilled = false;
    }
    
    handleCollisions() {
        const playerBounds = this.player.getBounds();
        const enemyBounds = this.enemies.getBounds();
        
        // Check if enemies reached player row
        if (this.enemies.getLowestY() > this.player.y) {
            this.gameOver();
            return;
        }
        
        // Player bullets vs enemies
        const allProjectiles = projectiles.getAll();
        for (let i = allProjectiles.length - 1; i >= 0; i--) {
            const bullet = allProjectiles[i];
            
            if (bullet.isPlayer) {
                // Check collision with enemies
                for (const enemy of this.enemies.enemies) {
                    if (!enemy.alive) continue;
                    
                    const enemyRect = {
                        x: enemy.x + this.enemies.gridOffsetX,
                        y: enemy.y,
                        width: enemy.width,
                        height: enemy.height
                    };
                    
                    if (checkCollision(bullet, enemyRect)) {
                        // Hit enemy
                        const result = this.enemies.hit(enemy, 1);
                        if (result) {
                            // Enemy destroyed
                            hud.addScore(result.points, hud.comboMultiplier);
                            this.comboKilled = true;
                            
                            // Drop power-up
                            const powerUp = powerUps.maybeDrop(result.x, result.y);
                            powerUps.add(powerUp);
                            
                            // Remove bullet
                            projectiles.projectiles.splice(i, 1);
                            break;
                        } else {
                            // Enemy hit but not destroyed
                            // Remove bullet
                            projectiles.projectiles.splice(i, 1);
                            break;
                        }
                    }
                }
            } else {
                // Enemy bullet vs player
                if (checkCollision(bullet, playerBounds)) {
                    // Player hit
                    if (this.player.hit()) {
                        // Shield absorbed hit
                        hud.setShield(this.player.shield);
                        hud.resetCombo();
                    } else {
                        // No shield left, game over
                        this.gameOver();
                    }
                    
                    // Remove bullet
                    projectiles.projectiles.splice(i, 1);
                }
            }
        }
        
        // Check power-up collisions
        powerUps.checkCollision(this.player);
        hud.setShield(this.player.shield);
        
        // Update combo
        if (this.comboKilled) {
            hud.updateCombo(true);
            this.comboKilled = false;
        } else {
            hud.updateCombo(false);
        }
    }
    
    checkGameOver() {
        if (this.player.shield <= 0) {
            this.gameOver();
        }
    }
    
    gameOver() {
        this.state = STATE.GAME_OVER;
        hud.saveHighScore();
        audio.playGameOver();
    }
    
    draw() {
        // Draw background
        background.draw(this.ctx);
        
        switch (this.state) {
            case STATE.MENU:
                this.drawMenu();
                break;
                
            case STATE.PLAYING:
                this.drawPlaying();
                break;
                
            case STATE.LEVEL_TRANSITION:
                this.drawPlaying();
                this.drawLevelTransition();
                break;
                
            case STATE.GAME_OVER:
                this.drawPlaying();
                this.drawGameOver();
                break;
        }
    }
    
    drawMenu() {
        hud.drawMenu(this.ctx);
    }
    
    drawPlaying() {
        // Draw enemies
        if (this.enemies) {
            this.enemies.draw(this.ctx);
        }
        
        // Draw player
        if (this.player) {
            this.player.draw(this.ctx);
        }
        
        // Draw projectiles
        projectiles.draw(this.ctx);
        
        // Draw particles
        particles.draw(this.ctx);
        
        // Draw power-ups
        powerUps.draw(this.ctx);
        
        // Draw HUD
        hud.draw(this.ctx);
    }
    
    drawLevelTransition() {
        hud.drawLevelTransition(this.ctx);
    }
    
    drawGameOver() {
        hud.drawGameOver(this.ctx);
    }
}

// Initialize game when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    new Game();
});