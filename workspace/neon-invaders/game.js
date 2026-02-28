// Main game file - ties everything together
import { player } from './player.js';
import { enemies, EnemyFactory } from './enemies.js';
import { bullets } from './bullets.js';
import { powerUps } from './powerups.js';
import { particles } from './particles.js';
import { audio } from './audio.js';

// Game state
const gameState = {
  score: 0,
  level: 1,
  lives: 3,
  gameOver: false,
  paused: false,
  wave: 1,
  waveDelay: 0,
  waveTimer: 0,
  highScore: 0,
  combo: 0,
  comboTimer: 0
};

// Input state
const input = {
  left: false,
  right: false,
  up: false,
  down: false,
  shoot: false,
  pause: false,
  restart: false
};

// Game constants
const GAME_WIDTH = window.innerWidth;
const GAME_HEIGHT = window.innerHeight;
const PLAYER_SPEED = 7;
const BULLET_SPEED = 12;
const ENEMY_SPAWN_RATE = 2000; // ms

// Setup canvas
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = GAME_WIDTH;
canvas.height = GAME_HEIGHT;

// Setup UI
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const levelEl = document.getElementById('level');
const waveEl = document.getElementById('wave');
const comboEl = document.getElementById('combo');
const gameOverEl = document.getElementById('gameOver');
const startScreenEl = document.getElementById('startScreen');

// Input handling
document.addEventListener('keydown', (e) => {
  switch(e.key) {
    case 'ArrowLeft':
    case 'a':
      input.left = true;
      break;
    case 'ArrowRight':
    case 'd':
      input.right = true;
      break;
    case 'ArrowUp':
    case 'w':
      input.up = true;
      break;
    case 'ArrowDown':
    case 's':
      input.down = true;
      break;
    case ' ':
      input.shoot = true;
      e.preventDefault();
      break;
    case 'p':
    case 'Escape':
      input.pause = true;
      break;
    case 'r':
      input.restart = true;
      break;
  }
});

document.addEventListener('keyup', (e) => {
  switch(e.key) {
    case 'ArrowLeft':
    case 'a':
      input.left = false;
      break;
    case 'ArrowRight':
    case 'd':
      input.right = false;
      break;
    case 'ArrowUp':
    case 'w':
      input.up = false;
      break;
    case 'ArrowDown':
    case 's':
      input.down = false;
      break;
    case ' ':
      input.shoot = false;
      break;
    case 'p':
    case 'Escape':
      input.pause = false;
      break;
    case 'r':
      input.restart = false;
      break;
  }
});

// Touch controls for mobile
let touchStartX = 0;
let touchStartY = 0;

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  
  // Right side of screen shoots
  if (touch.clientX > window.innerWidth / 2) {
    input.shoot = true;
  }
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  
  // Calculate direction from touch start
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  
  input.left = dx < -20;
  input.right = dx > 20;
  input.up = dy < -20;
  input.down = dy > 20;
  
  // Update touch start for continuous movement
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
});

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  input.left = false;
  input.right = false;
  input.up = false;
  input.down = false;
  input.shoot = false;
});

// Collision detection
function checkCollision(rect1, rect2) {
  return (
    rect1.x < rect2.x + rect2.width &&
    rect1.x + rect1.width > rect2.x &&
    rect1.y < rect2.y + rect2.height &&
    rect1.y + rect1.height > rect2.y
  );
}

// Update game state
function update(deltaTime) {
  if (gameState.gameOver || gameState.paused) return;
  
  // Update player
  player.update(deltaTime, input, PLAYER_SPEED);
  
  // Update bullets
  bullets.update(deltaTime, BULLET_SPEED);
  
  // Update enemies
  enemies.update(deltaTime, gameState.level);
  
  // Update power-ups
  powerUps.update(deltaTime);
  
  // Update particles
  particles.update();
  
  // Update combo timer
  if (gameState.comboTimer > 0) {
    gameState.comboTimer -= deltaTime;
    if (gameState.comboTimer <= 0) {
      gameState.combo = 0;
    }
  }
  
  // Wave management
  if (gameState.waveDelay > 0) {
    gameState.waveDelay -= deltaTime;
    if (gameState.waveDelay <= 0) {
      startNextWave();
    }
  }
  
  // Check collisions
  checkCollisions();
  
  // Update UI
  updateUI();
}

// Check all collisions
function checkCollisions() {
  // Player bullets hitting enemies
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    
    for (let j = enemies.length - 1; j >= 0; j--) {
      const enemy = enemies[j];
      
      if (checkCollision(bullet, enemy)) {
        // Hit enemy
        enemy.takeDamage(bullet.damage);
        bullets.splice(i, 1);
        
        if (enemy.health <= 0) {
          // Enemy destroyed
          const score = enemy.scoreValue * (1 + gameState.combo * 0.1);
          gameState.score += Math.floor(score);
          gameState.combo++;
          gameState.comboTimer = 3000; // 3 second combo window
          
          // Create effects
          particles.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2, enemy.size);
          particles.createScoreText(enemy.x, enemy.y, Math.floor(score));
          audio.playSound('enemyHit');
          
          // Chance to drop power-up
          if (Math.random() < 0.1) {
            powerUps.spawn(enemy.x + enemy.width/2, enemy.y + enemy.height/2);
          }
        } else {
          audio.playSound('enemyHit');
        }
        
        break;
      }
    }
  }
  
  // Enemies hitting player
  for (const enemy of enemies) {
    if (checkCollision(player, enemy)) {
      playerHit();
      particles.createExplosion(player.x + player.width/2, player.y + player.height/2, 'large');
      audio.playSound('playerHit');
      break;
    }
  }
  
  // Player collecting power-ups
  for (let i = powerUps.length - 1; i >= 0; i--) {
    const powerUp = powerUps[i];
    
    if (checkCollision(player, powerUp)) {
      player.collectPowerUp(powerUp.type);
      particles.createScoreText(player.x, player.y, '+100');
      audio.playSound('powerUp');
      powerUps.splice(i, 1);
    }
  }
  
  // Enemies reaching bottom
  for (const enemy of enemies) {
    if (enemy.y > GAME_HEIGHT) {
      playerHit();
      particles.createExplosion(enemy.x + enemy.width/2, enemy.y, 'medium');
      audio.playSound('playerHit');
    }
  }
}

// Player hit
function playerHit() {
  gameState.lives--;
  gameState.combo = 0;
  
  if (gameState.lives <= 0) {
    gameOver();
  } else {
    // Respawn player
    player.respawn();
    
    // Clear nearby enemies
    enemies.clearNear(player.x, player.y, 200);
    
    // Screen shake
    particles.createShakeEffect();
  }
}

// Start next wave
function startNextWave() {
  gameState.wave++;
  gameState.level = Math.floor((gameState.wave - 1) / 5) + 1;
  
  // Spawn enemies based on wave
  const enemyCount = 5 + gameState.wave * 2;
  const spawnRate = Math.max(500, ENEMY_SPAWN_RATE - gameState.wave * 100);
  
  for (let i = 0; i < enemyCount; i++) {
    setTimeout(() => {
      const x = Math.random() * (GAME_WIDTH - 60) + 30;
      const type = Math.floor(Math.random() * 3) + 1;
      enemies.spawn(x, -50, type, gameState.level);
    }, i * spawnRate);
  }
  
  audio.playSound('waveStart');
}

// Game over
function gameOver() {
  gameState.gameOver = true;
  gameOverEl.style.display = 'flex';
  
  // Update high score
  if (gameState.score > gameState.highScore) {
    gameState.highScore = gameState.score;
    localStorage.setItem('neonInvadersHighScore', gameState.highScore);
  }
  
  audio.playSound('gameOver');
}

// Reset game
function resetGame() {
  gameState.score = 0;
  gameState.lives = 3;
  gameState.wave = 1;
  gameState.level = 1;
  gameState.gameOver = false;
  gameState.combo = 0;
  gameState.waveDelay = 3000;
  
  player.reset();
  enemies.clear();
  bullets.clear();
  powerUps.clear();
  particles.clear();
  
  gameOverEl.style.display = 'none';
  startScreenEl.style.display = 'none';
  
  audio.playSound('start');
}

// Update UI
function updateUI() {
  scoreEl.textContent = gameState.score;
  livesEl.textContent = '❤'.repeat(gameState.lives);
  levelEl.textContent = gameState.level;
  waveEl.textContent = gameState.wave;
  
  if (gameState.combo > 1) {
    comboEl.textContent = `${gameState.combo}x COMBO!`;
    comboEl.style.opacity = 1;
  } else {
    comboEl.style.opacity = 0;
  }
}

// Draw game
function draw() {
  // Clear canvas
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  
  // Draw starfield background
  drawStarfield();
  
  // Draw game objects
  player.draw(ctx);
  enemies.draw(ctx);
  bullets.draw(ctx);
  powerUps.draw(ctx);
  particles.draw(ctx);
  
  // Draw UI
  drawUI();
}

// Draw starfield background
function drawStarfield() {
  // Static stars (could be animated)
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 100; i++) {
    const x = (Math.sin(i * 132.1) * 0.5 + 0.5) * GAME_WIDTH;
    const y = (Math.cos(i * 453.2) * 0.5 + 0.5) * GAME_HEIGHT;
    const size = Math.random() * 2;
    ctx.fillRect(x, y, size, size);
  }
}

// Draw UI
function drawUI() {
  // Score
  ctx.fillStyle = '#fff';
  ctx.font = '20px "Courier New"';
  ctx.textAlign = 'left';
  ctx.fillText(`SCORE: ${gameState.score}`, 20, 30);
  
  // High score
  ctx.textAlign = 'right';
  ctx.fillText(`HIGH: ${gameState.highScore}`, GAME_WIDTH - 20, 30);
  
  // Lives
  ctx.textAlign = 'left';
  ctx.fillText(`LIVES: ${'❤'.repeat(gameState.lives)}`, 20, 60);
  
  // Level and wave
  ctx.textAlign = 'center';
  ctx.fillText(`LEVEL ${gameState.level}`, GAME_WIDTH / 2, 30);
  ctx.fillText(`WAVE ${gameState.wave}`, GAME_WIDTH / 2, 60);
  
  // Combo
  if (gameState.combo > 1) {
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 24px "Courier New"';
    ctx.fillText(`${gameState.combo}x COMBO!`, GAME_WIDTH / 2, GAME_HEIGHT / 2);
  }
  
  // Pause indicator
  if (gameState.paused) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 48px "Courier New"';
    ctx.textAlign = 'center';
    ctx.fillText('PAUSED', GAME_WIDTH / 2, GAME_HEIGHT / 2);
    
    ctx.font = '24px "Courier New"';
    ctx.fillText('Press P or ESC to resume', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 50);
  }
}

// Game loop
let lastTime = 0;
let enemySpawnTimer = 0;

function gameLoop(timestamp) {
  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;
  
  // Handle restart
  if (input.restart > 0 && gameState.gameOver) {
    resetGame();
  }
  
  // Handle pause
  if (input.pause > 0 && !gameState.gameOver) {
    gameState.paused = !gameState.paused;
    input.pause = 0;
  }
  
  if (!gameState.paused && !gameState.gameOver) {
    update(deltaTime);
  }
  
  draw();
  
  requestAnimationFrame(gameLoop);
}

// Initialize game
function init() {
  // Load high score
  const savedHighScore = localStorage.getItem('neonInvadersHighScore');
  if (savedHighScore) {
    gameState.highScore = parseInt(savedHighScore);
  }
  
  // Start game loop
  requestAnimationFrame(gameLoop);
  
  // Start first wave after delay
  gameState.waveDelay = 3000;
  
  // Show start screen
  startScreenEl.style.display = 'flex';
}

// Start the game
init();
