// Neon Invaders - Enemies
// Enemy grid, formation movement, and attack patterns

import { CANVAS_WIDTH, CANVAS_HEIGHT, ENEMY, ENEMY_TYPES, COLORS, GLOW } from './config.js';

export class Enemy {
  constructor(x, y, type, level) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.level = level;
    
    // Get type properties
    const typeProps = ENEMY_TYPES[type];
    this.hp = typeProps.hp;
    this.maxHp = typeProps.hp;
    this.points = typeProps.points;
    this.color = typeProps.color;
    this.shape = typeProps.shape;
    this.speedMultiplier = typeProps.speedMultiplier;
    
    // Animation state
    this.idleTime = Math.random() * Math.PI * 2;
    this.hitFlashTime = 0;
    
    this.active = true;
  }

  update(dt, gameTime) {
    // Update idle animation
    this.idleTime += ENEMY.idlePulseSpeed * dt;
    
    // Update hit flash timer
    if (this.hitFlashTime > 0) {
      this.hitFlashTime -= dt;
    }
  }

  takeDamage() {
    this.hp--;
    this.hitFlashTime = 0.1; // Flash for 0.1 seconds
    
    if (this.hp <= 0) {
      this.active = false;
      return true; // Enemy destroyed
    }
    return false;
  }

  getBounds() {
    return {
      x: this.x - ENEMY.width / 2,
      y: this.y - ENEMY.height / 2,
      width: ENEMY.width,
      height: ENEMY.height
    };
  }

  draw(ctx) {
    ctx.save();
    
    // Calculate pulse for idle animation
    const pulse = 1 + Math.sin(this.idleTime) * 0.05;
    
    ctx.translate(this.x, this.y);
    ctx.scale(pulse, pulse);
    
    // Determine color (flash white if hit)
    let drawColor = this.color;
    if (this.hitFlashTime > 0) {
      drawColor = '#ffffff';
    }
    
    // Draw glow effect
    ctx.shadowBlur = GLOW.glowShadowBlur;
    ctx.shadowColor = drawColor;
    
    ctx.fillStyle = drawColor;
    
    // Draw enemy shape based on type
    switch (this.shape) {
      case 'diamond':
        this.drawDiamond(ctx);
        break;
      case 'hexagon':
        this.drawHexagon(ctx);
        break;
      case 'triangle':
        this.drawTriangle(ctx);
        break;
    }
    
    // Draw inner detail
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(0, 0, ENEMY.width / 6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
  }

  drawDiamond(ctx) {
    const w = ENEMY.width / 2;
    const h = ENEMY.height / 2;
    
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(w, 0);
    ctx.lineTo(0, h);
    ctx.lineTo(-w, 0);
    ctx.closePath();
    ctx.fill();
  }

  drawHexagon(ctx) {
    const w = ENEMY.width / 2;
    const h = ENEMY.height / 2;
    const angle = Math.PI / 3;
    
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = angle * i - Math.PI / 2;
      const x = Math.cos(a) * w;
      const y = Math.sin(a) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  drawTriangle(ctx) {
    const w = ENEMY.width / 2;
    const h = ENEMY.height / 2;
    
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(w, h);
    ctx.lineTo(-w, h);
    ctx.closePath();
    ctx.fill();
  }
}

export class EnemyGrid {
  constructor(level) {
    this.level = level;
    this.enemies = [];
    this.direction = 1; // 1 = right, -1 = left
    this.moveSpeed = ENEMY.baseMoveSpeed;
    this.moveTimer = 0;
    this.moveInterval = 1; // seconds between moves (decreases as enemies die)
    this.dropPending = false;
    this.dropTimer = 0;
    
    this.createGrid();
  }

  createGrid() {
    const rows = ENEMY.gridRows;
    const cols = ENEMY.gridCols;
    
    // Calculate starting Y based on level (each level starts lower)
    const startY = ENEMY.startY + Math.min(
      (this.level - 1) * LEVEL.rowOffsetPerLevel,
      100 // Cap the offset
    );
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = ENEMY.startX + col * ENEMY.horizontalSpacing;
        const y = startY + row * ENEMY.verticalSpacing;
        
        // Determine enemy type based on row and level
        const enemyType = this.getEnemyType(row, col);
        
        if (enemyType) {
          this.enemies.push(new Enemy(x, y, enemyType, this.level));
        }
      }
    }
  }

  getEnemyType(row, col) {
    // Back rows (higher row numbers) get tougher enemies
    const backRows = Math.ceil(ENEMY.gridRows / 3);
    const frontRows = Math.floor(ENEMY.gridRows / 3);
    
    if (row < frontRows) {
      // Front rows: Type A (Drone) or Type C (Scout) if level 3+
      if (this.level >= 3 && Math.random() < 0.3) {
        return 'C';
      }
      return 'A';
    } else if (row < ENEMY.gridRows - backRows) {
      // Middle rows: Type A
      return 'A';
    } else {
      // Back rows: Type B (Tank) if level 2+
      if (this.level >= 2) {
        return 'B';
      }
      return 'A';
    }
  }

  update(dt, gameTime) {
    // Update individual enemies
    this.enemies.forEach(enemy > enemy.update(dt, gameTime));
    
    // Remove dead enemies
    this.enemies = this.enemies.filter(e > e.active);
    
    // Check if grid is empty
    if (this.enemies.length === 0) {
      return true; // All enemies destroyed
    }
    
    // Handle formation movement
    this.updateFormation(dt);
    
    // Handle enemy firing
    this.updateFiring(dt, gameTime);
    
    return false;
  }

  updateFormation(dt) {
    // Calculate movement speed based on remaining enemies
    const enemyCount = this.enemies.length;
    const totalEnemies = ENEMY.gridRows * ENEMY.gridCols;
    const speedMultiplier = 1 + (1 - enemyCount / totalEnemies) * 2;
    const currentSpeed = this.moveSpeed * speedMultiplier;
    
    // Move horizontally
    this.enemies.forEach(enemy > {
      enemy.x += currentSpeed * this.direction * dt;
    });
    
    // Check edges
    let hitLeft = false;
    let hitRight = false;
    
    this.enemies.forEach(enemy > {
      const bounds = enemy.getBounds();
      if (bounds.x < 10) hitLeft = true;
      if (bounds.x + bounds.width > CANVAS_WIDTH - 10) hitRight = true;
    });
    
    // Change direction and drop if hitting edge
    if (hitLeft || hitRight) {
      this.direction *= -1;
      this.enemies.forEach(enemy > {
        enemy.y += ENEMY.moveDownAmount;
      });
    }
    
    // Check if enemies reached player level
    const playerY = CANVAS_HEIGHT - 80;
    for (const enemy of this.enemies) {
      if (enemy.y >= playerY) {
        return 'gameOver'; // Enemies reached player
      }
    }
  }

  updateFiring(dt, gameTime) {
    // Calculate fire chance based on level
    let fireChance = ENEMY.fireChance;
    
    // Increase fire rate every 5 levels
    const levelBonus = Math.floor(this.level / 5) * LEVEL.maxEnemyFireIncrease;
    fireChance *= (1 + levelBonus);
    
    // Each enemy has a chance to fire
    this.enemies.forEach(enemy > {
      if (Math.random() < fireChance * dt) {
        enemy.canFire = true;
      }
    });
  }

  // Get enemies that can fire
  getFiringEnemies() {
    const firing = [];
    this.enemies.forEach(enemy > {
      if (enemy.canFire) {
        firing.push(enemy);
        enemy.canFire = false;
      }
    });
    return firing;
  }

  // Get all enemies for rendering
  getAll() {
    return this.enemies;
  }

  // Get enemy count
  getCount() {
    return this.enemies.length;
  }

  // Draw all enemies
  draw(ctx) {
    this.enemies.forEach(enemy > enemy.draw(ctx));
  }

  // Check if grid is empty
  isEmpty() {
    return this.enemies.length === 0;
  }
}

export default EnemyGrid;
