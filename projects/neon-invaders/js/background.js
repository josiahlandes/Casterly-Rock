// Background - Animated grid, stars, and scanlines
import { CONFIG } from './config.js';

export class Background {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.stars = this.createStars();
        this.gridOffset = 0;
        this.scanlineOffset = 0;
    }
    
    createStars() {
        const stars = [];
        // Two depth layers
        for (let i = 0; i < 80; i++) {
            stars.push({
                x: Math.random() * this.width,
                y: Math.random() * this.height,
                size: Math.random() * 2 + 0.5,
                brightness: Math.random(),
                depth: Math.random() > 0.5 ? 1 : 2,
                speed: Math.random() * 0.5 + 0.2
            });
        }
        return stars;
    }
    
    update(dt) {
        // Move stars slowly
        this.stars.forEach(star => {
            star.y += star.speed * 10 * dt;
            if (star.y > this.height) {
                star.y = 0;
                star.x = Math.random() * this.width;
            }
            // Twinkle
            star.brightness += (Math.random() - 0.5) * 0.1;
            star.brightness = Math.max(0.3, Math.min(1, star.brightness));
        });
        
        // Move grid
        this.gridOffset += 20 * dt;
        if (this.gridOffset > 40) {
            this.gridOffset = 0;
        }
        
        // Move scanlines
        this.scanlineOffset += 2 * dt;
        if (this.scanlineOffset > 4) {
            this.scanlineOffset = 0;
        }
    }
    
    draw(ctx) {
        // Background fill
        ctx.fillStyle = CONFIG.COLORS.BACKGROUND;
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Draw stars (parallax)
        this.stars.forEach(star => {
            ctx.fillStyle = `rgba(255, 255, 255, ${star.brightness})`;
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.size * (star.depth === 1 ? 0.7 : 1), 0, Math.PI * 2);
            ctx.fill();
        });
        
        // Draw perspective grid
        this.drawGrid(ctx);
        
        // Draw scanlines
        this.drawScanlines(ctx);
    }
    
    drawGrid(ctx) {
        ctx.strokeStyle = CONFIG.COLORS.GRID;
        ctx.lineWidth = 1;
        
        const vanishingPointY = this.height * 0.3;
        const gridSpacing = 40;
        
        // Vertical perspective lines
        const centerX = this.width / 2;
        for (let i = -10; i <= 10; i++) {
            const x = centerX + i * gridSpacing;
            ctx.beginPath();
            ctx.moveTo(x, vanishingPointY);
            ctx.lineTo(x * 0.3 + centerX * 0.7, this.height);
            ctx.stroke();
        }
        
        // Horizontal lines (perspective)
        for (let i = 0; i < 15; i++) {
            const y = vanishingPointY + Math.pow(i / 15, 2) * (this.height - vanishingPointY);
            const yOffset = (i === 14) ? this.gridOffset : 0;
            ctx.beginPath();
            ctx.moveTo(0, y + yOffset);
            ctx.lineTo(this.width, y + yOffset);
            ctx.stroke();
        }
    }
    
    drawScanlines(ctx) {
        ctx.fillStyle = CONFIG.COLORS.SCANLINE;
        for (let y = this.scanlineOffset; y < this.height; y += 4) {
            ctx.fillRect(0, y, this.width, 1);
        }
    }
}