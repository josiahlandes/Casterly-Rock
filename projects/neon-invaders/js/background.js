import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS } from './config.js';

export default class Background {
    constructor() {
        this.stars = this.generateStars();
        this.scanLineOffset = 0;
        this.gridOffset = 0;
    }
    
    generateStars() {
        const stars = [];
        const numStars = 100;
        
        for (let i = 0; i < numStars; i++) {
            stars.push({
                x: Math.random() * CANVAS_WIDTH,
                y: Math.random() * CANVAS_HEIGHT,
                size: Math.random() * 1.5 + 0.5,
                brightness: Math.random() * 0.5 + 0.5,
                depth: Math.random() < 0.5 ? 0.5 : 1,
                twinkleSpeed: Math.random() * 2 + 1,
                twinkleOffset: Math.random() * Math.PI * 2
            });
        }
        
        return stars;
    }
    
    update(dt, gameSpeed = 0) {
        // Update scan line position
        this.scanLineOffset = (this.scanLineOffset + dt * 50) % 20;
        
        // Update grid offset for subtle movement
        this.gridOffset = (this.gridOffset + dt * 20) % 40;
        
        // Update stars
        this.stars.forEach(star => {
            // Move stars based on depth (parallax)
            star.x -= dt * star.depth * 10;
            
            // Wrap around
            if (star.x < 0) {
                star.x = CANVAS_WIDTH;
            }
        });
    }
    
    draw(ctx) {
        // Draw background
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
        ctx.save();
        
        // Perspective grid lines (horizontal)
        const horizonY = CANVAS_HEIGHT * 0.3;
        const floorHeight = CANVAS_HEIGHT - horizonY;
        
        ctx.strokeStyle = 'rgba(0, 255, 245, 0.1)';
        ctx.lineWidth = 1;
        
        // Horizontal perspective lines
        for (let i = 0; i < 15; i++) {
            const y = horizonY + Math.pow(i / 15, 2) * floorHeight;
            ctx.globalAlpha = 0.1 + (1 - i / 15) * 0.2;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(CANVAS_WIDTH, y);
            ctx.stroke();
        }
        
        // Vertical perspective lines
        const centerX = CANVAS_WIDTH / 2;
        for (let i = -10; i <= 10; i++) {
            const x = centerX + i * 60;
            ctx.globalAlpha = 0.05 + (1 - Math.abs(i) / 10) * 0.15;
            ctx.beginPath();
            ctx.moveTo(x, horizonY);
            ctx.lineTo(centerX + i * 200, CANVAS_HEIGHT);
            ctx.stroke();
        }
        
        ctx.restore();
    }
    
    drawStars(ctx) {
        this.stars.forEach(star => {
            const twinkle = Math.sin(Date.now() / 1000 * star.twinkleSpeed + star.twinkleOffset);
            const alpha = star.brightness * (0.7 + twinkle * 0.3);
            
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.size * star.depth, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    
    drawScanLines(ctx) {
        ctx.save();
        ctx.fillStyle = COLORS.scanLine;
        
        // Draw scrolling scan lines
        for (let y = this.scanLineOffset; y < CANVAS_HEIGHT; y += 20) {
            ctx.fillRect(0, y, CANVAS_WIDTH, 2);
        }
        
        ctx.restore();
    }
    
    reset() {
        this.stars = this.generateStars();
        this.scanLineOffset = 0;
        this.gridOffset = 0;
    }
}
