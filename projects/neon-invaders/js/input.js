// Input Handler - Keyboard management
export class InputHandler {
    constructor() {
        this.keys = {};
        this.keyDown = {};
        this.keyUp = {};
        
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    }
    
    handleKeyDown(e) {
        const key = e.code;
        if (!this.keys[key]) {
            this.keyDown[key] = true;
        }
        this.keys[key] = true;
    }
    
    handleKeyUp(e) {
        const key = e.code;
        this.keys[key] = false;
        this.keyUp[key] = true;
    }
    
    isDown(code) {
        return this.keys[code] === true;
    }
    
    isPressed(code) {
        const pressed = this.keyDown[code] === true;
        this.keyDown[code] = false;
        return pressed;
    }
    
    isReleased(code) {
        const released = this.keyUp[code] === true;
        this.keyUp[code] = false;
        return released;
    }
    
    // Convenience methods for common controls
    isLeft() {
        return this.isDown('ArrowLeft') || this.isDown('KeyA');
    }
    
    isRight() {
        return this.isDown('ArrowRight') || this.isDown('KeyD');
    }
    
    isShoot() {
        return this.isDown('Space');
    }
    
    isStart() {
        return this.isPressed('Enter');
    }
    
    isRestart() {
        return this.isPressed('Enter');
    }
    
    clear() {
        this.keyDown = {};
        this.keyUp = {};
    }
}