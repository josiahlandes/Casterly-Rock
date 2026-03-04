// Background Module (Perspective grid, star field, scan lines)

import { COLORS, CANVAS } from './config.js';

class Background {
    constructor() {
        this.starField1 = this.createStarField(80, 1);
        this.starField2 = this.createStarField(50, 0.5);
        this.scanLineY = 0;
        this.gridOffsetY = 0;
        this.animTimer = 0;
    }
    
    createStarField(count, depth) {
        const stars = [];
        for (let i = 0; i < count; i++) {
            stars.push({
                x: Math.random() * CANVAS.WIDTH,
                y: Math.random() * CANVAS.HEIGHT,
                brightness: 0.3 + Math.random() * 0.7,
                size: depth * (0.5 + Math.random() * 1)
            });
        }
        return stars;
    }
    
    update(dt) {
        this.animTimer += dt;
        
        // Move stars slowly
        for (const star of this.starField1) {
            star.y += 10 * dt;
            if (star.y > CANVAS.HEIGHT) {
                star.y = 0;
                star.x = Math.random() * CANVAS.WIDTH;
            }
        }
        
        for (const star of this.starField2) {
            star.y += 5 * dt;
            if (star.y > CANVAS.HEIGHT) {
                star.y = 0;
                star.x = Math.random() * CANVAS.WIDTH;
            }
        }
        
        // Animate scan line
        this.scanLineY += 50 * dt;
        if (this.scanLineY > CANVAS.HEIGHT) {
            this.scanLineY = 0;
        }
        
        // Animate grid
        this.gridOffsetY += 30 * dt;
        if (this.gridOffsetY > 40) {
            this.gridOffsetY = 0;
        }
    }
    
    draw(ctx) {
        // Clear with background color
        ctx.fillStyle = COLORS.BACKGROUND;
        ctx.fillRect(0, 0, CANVAS.WIDTH, CANVAS.HEIGHT);
        
        // Draw perspective grid
        this.drawGrid(ctx);
        
        // Draw star fields
        this.drawStars(ctx, this.starField2);  // Far stars (dimmer, slower)
        this.drawStars(ctx, this.starField1);  // Near stars (brighter, faster)
        
        // Draw scan lines
        this.drawScanLines(ctx);
    }
    
    drawGrid(ctx) {
        ctx.save();
        
        // Vertical lines (perspective)
        const centerX = CANVAS.WIDTH / 2;
        const vanishingY = 150;  // Vanishing point Y
        
        ctx.strokeStyle = 'rgba(0, 255, 245, 0.1)';
        ctx.lineWidth = 1;
        
        // Draw vertical perspective lines
        for (let i = -10; i <= 10; i++) {
            const x = centerX + i * 60;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(centerX + i * 200, CANVAS.HEIGHT);
            ctx.stroke();
        }
        
        // Horizontal lines (moving down)
        ctx.strokeStyle = 'rgba(0, 255, 245, 0.05)';
        
        for (let i = 0; i < 15; i++) {
            // Perspective horizontal lines
            const y = vanishingY + i * 30 + this.gridOffsetY;
            if (y > CANVAS.HEIGHT) continue;
            
            // Calculate width at this Y (narrower near vanishing point)
            const progress = (y - vanishingY) / (CANVAS.HEIGHT - vanishingY);
            const width = 20 + progress * 780;
            const xStart = (CANVAS.WIDTH - width) / 2;
            
            ctx.beginPath();
            ctx.moveTo(xStart, y);
            ctx.lineTo(xStart + width, y);
            ctx.stroke();
        }
        
        ctx.restore();
    }
    
    drawStars(ctx, stars) {
        ctx.save();
        
        for (const star of stars) {
            const alpha = star.brightness;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
    
    drawScanLines(ctx) {
        ctx.save();
        
        // Draw horizontal scan lines
        ctx.strokeStyle = COLORS.SCANLINE;
        ctx.lineWidth = 2;
        
        const spacing = 4;
        for (let y = this.scanLineY; y < CANVAS.HEIGHT; y += spacing) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(CANVAS.WIDTH, y);
            ctx.stroke();
        }
        
        ctx.restore();
    }
}

// Export singleton
export const background = new Background();