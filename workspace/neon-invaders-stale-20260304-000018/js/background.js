// Animated background: grid, stars, scan lines

import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS } from './config.js';

class Background {
    constructor() {
        this.stars = this.createStars();
        this.scanLineY = 0;
        this.time = 0;
    }
    
    createStars() {
        const stars = [];
        // Two depth layers
        for (let i = 0; i < 100; i++) {
            stars.push({
                x: Math.random() * CANVAS_WIDTH,
                y: Math.random() * CANVAS_HEIGHT,
                size: Math.random() * 2 + 0.5,
                brightness: Math.random(),
                depth: Math.random() > 0.5 ? 1 : 2 // 1 = far, 2 = near
            });
        }
        return stars;
    }
    
    update(dt) {
        this.time += dt;
        
        // Move stars (parallax)
        this.stars.forEach(star => {
            star.y += star.depth * 10 * dt;
            if (star.y > CANVAS_HEIGHT) {
                star.y = 0;
                star.x = Math.random() * CANVAS_WIDTH;
            }
            // Twinkle
            star.brightness += (Math.random() - 0.5) * 0.1;
            star.brightness = Math.max(0.3, Math.min(1, star.brightness));
        });
        
        // Move scan line
        this.scanLineY += 50 * dt;
        if (this.scanLineY > CANVAS_HEIGHT) {
            this.scanLineY = 0;
        }
    }
    
    draw(ctx) {
        // Fill background
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        
        // Draw perspective grid
        this.drawGrid(ctx);
        
        // Draw stars
        this.drawStars(ctx);
        
        // Draw scan lines
        this.drawScanLines(ctx);
    }
    
    drawGrid(ctx) {
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        
        // Vertical lines (perspective)
        const centerX = CANVAS_WIDTH / 2;
        const vanishingY = 150;
        
        for (let i = -10; i <= 10; i++) {
            const x = centerX + i * 40;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(centerX + i * 150, CANVAS_HEIGHT);
            ctx.stroke();
        }
        
        // Horizontal lines (perspective, fading toward vanishing point)
        for (let i = 0; i < 15; i++) {
            const y = vanishingY + i * 35;
            const alpha = 1 - (i / 15);
            ctx.globalAlpha = alpha * 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(CANVAS_WIDTH, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
    
    drawStars(ctx) {
        this.stars.forEach(star => {
            ctx.fillStyle = `rgba(255, 255, 255, ${star.brightness})`;
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    
    drawScanLines(ctx) {
        ctx.strokeStyle = COLORS.scanline;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.1;
        
        for (let y = this.scanLineY; y < CANVAS_HEIGHT; y += 4) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(CANVAS_WIDTH, y);
            ctx.stroke();
        }
        
        ctx.globalAlpha = 1;
    }
}

export default Background;