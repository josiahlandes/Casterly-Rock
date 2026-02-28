// Enemy class for Neon Invaders
import { CONFIG } from './config.js';

export class Enemy {
  constructor(x, y, type = 'basic') {
    this.x = x;
    this.y = y;
    this.type = type;
    this.width = CONFIG.ENEMY_WIDTH;
    this.height = CONFIG.ENEMY_HEIGHT;
    this.alive = true;
    this.scoreValue = 100;
    
    // Set properties based on enemy type
    this.setEnemyType(type);
    
    // Movement
    this.direction = 1; // 1 = right, -1 = left
    this.moveTimer = 0;
    this.moveInterval = CONFIG.ENEMY_MOVE_INTERVAL;
    
    // Shooting
    this.shootTimer = Math.random() * CONFIG.ENEMY_SHOOT_INTERVAL;
    
    // Animation
    this.animationFrame = 0;
    this.animationTimer = 0;
  }

  setEnemyType(type) {
    switch (type) {
      case 'fast':
        this.color = CONFIG.ENEMY_COLORS.fast;
        this.speed = CONFIG.ENEMY_SPEED * 1.5;
        this.scoreValue = 200;
        this.health = 1;
        break;
      case 'tank':
        this.color = CONFIG.ENEMY_COLORS.tank;
        this.speed = CONFIG.ENEMY_SPEED * 0.5;
        this.scoreValue = 300;
        this.health = 3;
        this.width = CONFIG.ENEMY_WIDTH * 1.5;
        this.height = CONFIG.ENEMY_HEIGHT * 1.5;
        break;
      case 'shooter':
        this.color = CONFIG.ENEMY_COLORS.shooter;
        this.speed = CONFIG.ENEMY_SPEED;
        this.scoreValue = 250;
        this.health = 2;
        break;
      default: // basic
        this.color = CONFIG.ENEMY_COLORS.basic;
        this.speed = CONFIG.ENEMY_SPEED;
        this.scoreValue = 100;
        this.health = 1;
    }
  }

  update(deltaTime, gridWidth, gridXOffset) {
    if (!this.alive) return;

    // Update animation
    this.animationTimer += deltaTime;
    if (this.animationTimer > 500) {
      this.animationFrame = (this.animationFrame + 1) % 2;
      this.animationTimer = 0;
    }

    // Update shoot timer
    this.shootTimer += deltaTime;
  }

  move(direction, moveDown = false) {
    if (!this.alive) return;
    
    this.x += direction * this.speed;
    
    if (moveDown) {
      this.y += CONFIG.ENEMY_DROP_DISTANCE;
    }
  }

  shouldShoot() {
    if (!this.alive) return false;
    
    if (this.shootTimer >= CONFIG.ENEMY_SHOOT_INTERVAL) {
      this.shootTimer = 0;
      return true;
    }
    return false;
  }

  takeDamage() {
    if (!this.alive) return 0;
    
    this.health--;
    if (this.health <= 0) {
      this.alive = false;
      return this.scoreValue;
    }
    return 0;
  }

  draw(ctx) {
    if (!this.alive) return;

    ctx.save();
    
    // Glow effect
    ctx.shadowBlur = 10;
    ctx.shadowColor = this.color;
    ctx.fillStyle = this.color;

    // Draw enemy based on type
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;

    if (this.type === 'tank') {
      // Tank enemy - larger square with details
      ctx.fillRect(this.x, this.y, this.width, this.height);
      ctx.fillStyle = '#000';
      ctx.fillRect(this.x + 5, this.y + 5, this.width - 10, this.height - 10);
    } else if (this.type === 'fast') {
      // Fast enemy - smaller triangle
      ctx.beginPath();
      ctx.moveTo(centerX, this.y);
      ctx.lineTo(this.x + this.width, this.y + this.height);
      ctx.lineTo(this.x, this.y + this.height);
      ctx.closePath();
      ctx.fill();
    } else if (this.type === 'shooter') {
      // Shooter enemy - diamond shape
      ctx.beginPath();
      ctx.moveTo(centerX, this.y);
      ctx.lineTo(this.x + this.width, centerY);
      ctx.lineTo(centerX, this.y + this.height);
      ctx.lineTo(this.x, centerY);
      ctx.closePath();
      ctx.fill();
    } else {
      // Basic enemy - classic invader shape
      if (this.animationFrame === 0) {
        // Frame 0
        ctx.fillRect(this.x + 2, this.y, this.width - 4, this.height - 4);
        ctx.fillRect(this.x, this.y + 4, 2, this.height - 8);
        ctx.fillRect(this.x + this.width - 2, this.y + 4, 2, this.height - 8);
      } else {
        // Frame 1
        ctx.fillRect(this.x + 2, this.y + 2, this.width - 4, this.height - 6);
        ctx.fillRect(this.x, this.y + 2, 2, this.height - 4);
        ctx.fillRect(this.x + this.width - 2, this.y + 2, 2, this.height - 4);
      }
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
