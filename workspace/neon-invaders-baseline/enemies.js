// Enemy system for Neon Invaders
import { CONFIG } from './config.js';

export class Enemy {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.width = CONFIG.ENEMY_WIDTH;
    this.height = CONFIG.ENEMY_HEIGHT;
    this.type = type;
    this.alive = true;
    this.flashTimer = 0;
    
    // Set properties based on enemy type
    switch (type) {
      case 'A': // Drone - basic
        this.color = CONFIG.ENEMY_COLORS[0];
        this.health = 1;
        this.scoreValue = 100;
        this.speed = CONFIG.ENEMY_SPEED_BASE;
        break;
      case 'B': // Tank - armored
        this.color = CONFIG.ENEMY_COLORS[1];
        this.health = 2;
        this.scoreValue = 250;
        this.speed = CONFIG.ENEMY_SPEED_BASE * 0.7;
        break;
      case 'C': // Scout - fast
        this.color = CONFIG.ENEMY_COLORS[2];
        this.health = 1;
        this.scoreValue = 200;
        this.speed = CONFIG.ENEMY_SPEED_BASE * 1.5;
        break;
      default:
        this.color = CONFIG.ENEMY_COLORS[0];
        this.health = 1;
        this.scoreValue = 100;
        this.speed = CONFIG.ENEMY_SPEED_BASE;
    }
  }

  update(deltaTime, formationOffset) {
    // Apply formation movement offset
    this.x = this.baseX + formationOffset.x;
    this.y = this.baseY + formationOffset.y;
    
    // Flash effect when hit
    if (this.flashTimer > 0) {
      this.flashTimer -= deltaTime;
    }
  }

  takeDamage(amount) {
    this.health -= amount;
    this.flashTimer = 100; // Flash for 100ms
    
    if (this.health <= 0) {
      this.alive = false;
    }
  }

  // Check if shield is depleted (for consistency with player interface)
  isShieldDepleted() {
    return this.health <= 0;
  }

  // Die method (for consistency with player interface)
  die() {
    this.alive = false;
    this.health = 0;
    return true;
  }

  draw(ctx) {
    ctx.save();
    
    // Glow effect
    ctx.shadowBlur = 15;
    ctx.shadowColor = this.flashTimer > 0 ? '#ffffff' : this.color;
    
    // Draw enemy based on type
    ctx.fillStyle = this.flashTimer > 0 ? '#ffffff' : this.color;
    
    switch (this.type) {
      case 'A': // Diamond shape
        ctx.beginPath();
        ctx.moveTo(this.x + this.width / 2, this.y);
        ctx.lineTo(this.x + this.width, this.y + this.height / 2);
        ctx.lineTo(this.x + this.width / 2, this.y + this.height);
        ctx.lineTo(this.x, this.y + this.height / 2);
        ctx.closePath();
        ctx.fill();
        break;
        
      case 'B': // Hexagon shape
        ctx.beginPath();
        ctx.moveTo(this.x + this.width * 0.2, this.y);
        ctx.lineTo(this.x + this.width * 0.8, this.y);
        ctx.lineTo(this.x + this.width, this.y + this.height / 2);
        ctx.lineTo(this.x + this.width * 0.8, this.y + this.height);
        ctx.lineTo(this.x + this.width * 0.2, this.y + this.height);
        ctx.lineTo(this.x, this.y + this.height / 2);
        ctx.closePath();
        ctx.fill();
        break;
        
      case 'C': // Triangle shape
        ctx.beginPath();
        ctx.moveTo(this.x + this.width / 2, this.y);
        ctx.lineTo(this.x + this.width, this.y + this.height);
        ctx.lineTo(this.x, this.y + this.height);
        ctx.closePath();
        ctx.fill();
        break;
        
      default:
        ctx.fillRect(this.x, this.y, this.width, this.height);
    }
    
    ctx.restore();
  }

  getBounds() {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height
    };
  }
}

export class EnemyFormation {
  constructor(rows, cols, level) {
    this.enemies = [];
    this.rows = rows;
    this.cols = cols;
    this.direction = 1; // 1 = right, -1 = left
    this.speed = CONFIG.ENEMY_SPEED_BASE;
    this.dropDistance = CONFIG.ENEMY_DROP_DISTANCE;
    this.moveTimer = 0;
    this.moveInterval = 500; // ms between moves
    this.shootTimer = 0;
    this.shootInterval = 2000; // ms between enemy shots
    
    this.initializeEnemies(level);
  }

  initializeEnemies(level) {
    const startX = 50;
    const startY = 50 + (level - 1) * 20; // Start lower each level
    const spacingX = (CONFIG.CANVAS_WIDTH - 100) / this.cols;
    const spacingY = 40;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        let type = 'A';
        
        // Determine enemy type based on level and row
        if (level >= 3 && row === 0) {
          type = 'C'; // Fast scouts in front row for level 3+
        } else if (level >= 2 && (row === 0 || row === 1)) {
          type = 'B'; // Armored tanks in back rows for level 2+
        }
        
        const enemy = new Enemy(
          startX + col * spacingX,
          startY + row * spacingY,
          type
        );
        enemy.baseX = startX + col * spacingX;
        enemy.baseY = startY + row * spacingY;
        this.enemies.push(enemy);
      }
    }
  }

  update(deltaTime, level) {
    // Increase speed as enemies are destroyed
    const aliveCount = this.enemies.filter(e => e.alive).length;
    const totalEnemies = this.rows * this.cols;
    const speedMultiplier = 1 + (1 - aliveCount / totalEnemies) * 2;
    this.speed = CONFIG.ENEMY_SPEED_BASE * speedMultiplier;
    
    // Adjust shoot frequency based on level
    this.shootInterval = Math.max(500, 2000 - level * 300);
    if (level >= 5) {
      this.shootInterval *= 0.5; // 50% more frequent after level 5
    }

    // Update move timer
    this.moveTimer += deltaTime;
    if (this.moveTimer >= this.moveInterval / speedMultiplier) {
      this.moveTimer = 0;
      this.move();
    }

    // Update shoot timer
    this.shootTimer += deltaTime;
    if (this.shootTimer >= this.shootInterval) {
      this.shootTimer = 0;
      return this.tryShoot();
    }

    // Update all enemies
    const formationOffset = { x: 0, y: 0 };
    for (const enemy of this.enemies) {
      if (enemy.alive) {
        enemy.update(deltaTime, formationOffset);
      }
    }

    return null;
  }

  move() {
    let hitEdge = false;
    let lowestY = 0;

    // Check if any enemy hit the edge
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      
      if (this.direction === 1 && enemy.x + enemy.width >= CONFIG.CANVAS_WIDTH - 20) {
        hitEdge = true;
        break;
      }
      if (this.direction === -1 && enemy.x <= 20) {
        hitEdge = true;
        break;
      }
      
      if (enemy.y + enemy.height > lowestY) {
        lowestY = enemy.y + enemy.height;
      }
    }

    if (hitEdge) {
      // Change direction and drop down
      this.direction *= -1;
      for (const enemy of this.enemies) {
        enemy.baseY += this.dropDistance;
        enemy.y += this.dropDistance;
      }
    } else {
      // Move horizontally
      const moveAmount = 10 * this.direction;
      for (const enemy of this.enemies) {
        enemy.baseX += moveAmount;
        enemy.x += moveAmount;
      }
    }

    return lowestY;
  }

  tryShoot() {
    // Get all alive enemies
    const aliveEnemies = this.enemies.filter(e => e.alive);
    if (aliveEnemies.length === 0) return null;

    // Random enemy shoots
    const shooter = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
    
    return {
      x: shooter.x + shooter.width / 2,
      y: shooter.y + shooter.height,
      width: CONFIG.PROJECTILE_WIDTH,
      height: CONFIG.PROJECTILE_HEIGHT,
      vy: CONFIG.PROJECTILE_SPEED * 0.6,
      color: '#ff3333'
    };
  }

  getAliveEnemies() {
    return this.enemies.filter(e => e.alive);
  }

  allDestroyed() {
    return this.enemies.every(e => !e.alive);
  }

  reachedPlayerRow(playerY) {
    for (const enemy of this.enemies) {
      if (enemy.alive && enemy.y + enemy.height >= playerY) {
        return true;
      }
    }
    return false;
  }

  draw(ctx) {
    for (const enemy of this.enemies) {
      if (enemy.alive) {
        enemy.draw(ctx);
      }
    }
  }

  clear() {
    this.enemies = [];
  }
}

// Factory function for creating enemy formations
export function createEnemyFormation(level) {
  return new EnemyFormation(CONFIG.ENEMY_ROWS, CONFIG.ENEMY_COLS, level);
}

// Export for game.js
export const enemies = {
  formation: null,
  
  init(level) {
    this.formation = createEnemyFormation(level);
  },
  
  update(deltaTime, level) {
    if (!this.formation) return null;
    return this.formation.update(deltaTime, level);
  },
  
  draw(ctx) {
    if (this.formation) {
      this.formation.draw(ctx);
    }
  },
  
  allDestroyed() {
    return this.formation && this.formation.allDestroyed();
  },
  
  reachedPlayerRow(playerY) {
    return this.formation && this.formation.reachedPlayerRow(playerY);
  },
  
  tryShoot() {
    return this.formation && this.formation.tryShoot();
  },
  
  clear() {
    if (this.formation) {
      this.formation.clear();
      this.formation = null;
    }
  }
};

export { Enemy, EnemyFormation };
