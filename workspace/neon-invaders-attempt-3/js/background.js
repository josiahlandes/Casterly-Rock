// Neon Invaders - Background Renderer
// Animated background with grid, stars, and scan lines

import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS, BACKGROUND } from './config.js';

export class Background {
  constructor(ctx) {
    this.ctx = ctx;
    this.scanlineY = 0;
    this.starTime = 0;
    
    // Initialize stars
    this.stars = this.createStars();
  }

  createStars() {
    const stars = [];
    
    for (let i = 0; i < BACKGROUND.starCount; i++) {
      const depth = Math.random() < 0.5 ? 1 : 2; // Two parallax depths
      stars.push({
        x: Math.random() * CANVAS_WIDTH,
        y: Math.random() * CANVAS_HEIGHT,
        size: Math.random() * 1.5 + 0.5,
        brightness: Math.random() * 0.5 + 0.5,
        depth: depth,
        twinkleSpeed: Math.random() * 2 + 1,
        twinkleOffset: Math.random() * Math.PI * 2
      });
    }
    
    return stars;
  }

  update(dt, gameTime) {
    // Update scanline position
    this.scanlineY = (this.scanlineY + BACKGROUND.scanlineSpeed * dt) % CANVAS_HEIGHT;
    
    // Update star time for twinkling
    this.starTime += dt;
    
    // Update star positions (parallax movement)
    this.stars.forEach(star > {
      // Stars move slower based on depth
      const speed = 10 / star.depth;
      star.x -= speed * dt;
      
      // Wrap around
      if (star.x < 0) {
        star.x = CANVAS_WIDTH;
      }
    });
  }

  draw() {
    // Draw background fill
    this.ctx.fillStyle = COLORS.background;
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Draw perspective grid
    this.drawGrid();
    
    // Draw stars
    this.drawStars();
    
    // Draw scan lines
    this.drawScanlines();
  }

  drawGrid() {
    this.ctx.save();
    this.ctx.strokeStyle = COLORS.grid;
    this.ctx.lineWidth = 1;
    
    // Vertical perspective lines (converging toward vanishing point)
    const vanishingPointY = CANVAS_HEIGHT * 0.3; // Vanishing point at 30% from top
    const numVerticalLines = 12;
    
    for (let i = 0; i <= numVerticalLines; i++) {
      const x = (i / numVerticalLines) * CANVAS_WIDTH;
      
      // Lines converge toward center at vanishing point
      const bottomX = x;
      const topX = CANVAS_WIDTH / 2 + (x - CANVAS_WIDTH / 2) * 0.3;
      
      this.ctx.beginPath();
      this.ctx.moveTo(topX, 0);
      this.ctx.lineTo(bottomX, CANVAS_HEIGHT);
      this.ctx.stroke();
    }
    
    // Horizontal lines (perspective spacing)
    const numHorizontalLines = 8;
    for (let i = 0; i <= numHorizontalLines; i++) {
      // Exponential spacing for perspective effect
      const t = i / numHorizontalLines;
      const y = CANVAS_HEIGHT * 0.3 + Math.pow(t, 2) * (CANVAS_HEIGHT * 0.7);
      
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(CANVAS_WIDTH, y);
      this.ctx.stroke();
    }
    
    this.ctx.restore();
  }

  drawStars() {
    this.stars.forEach(star > {
      // Twinkle effect
      const twinkle = Math.sin(this.starTime * star.twinkleSpeed + star.twinkleOffset);
      const alpha = star.brightness * (0.5 + 0.5 * twinkle);
      
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = COLORS.stars;
      
      // Parallax brightness based on depth
      this.ctx.globalAlpha *= (star.depth === 1 ? 0.6 : 1.0);
      
      this.ctx.beginPath();
      this.ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    });
  }

  drawScanlines() {
    this.ctx.save();
    this.ctx.fillStyle = COLORS.scanline;
    
    // Draw multiple scan lines
    const numLines = Math.ceil(CANVAS_HEIGHT / BACKGROUND.scanlineHeight) + 1;
    
    for (let i = 0; i < numLines; i++) {
      const y = this.scanlineY + i * BACKGROUND.scanlineHeight;
      if (y < CANVAS_HEIGHT) {
        this.ctx.fillRect(0, y, CANVAS_WIDTH, BACKGROUND.scanlineHeight);
      }
    }
    
    this.ctx.restore();
  }

  // Reset background state (for new game)
  reset() {
    this.scanlineY = 0;
    this.starTime = 0;
    this.stars = this.createStars();
  }
}

export default Background;
