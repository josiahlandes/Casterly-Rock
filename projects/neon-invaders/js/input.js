// Input Handler - Keyboard input management
export default class InputHandler {
    constructor() {
        this.keys = {};
        this.keyPressed = {};
        
        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            // Track first press this frame
            if (!this.keyPressed[e.code]) {
                this.keyPressed[e.code] = true;
            }
            // Prevent default for game keys
            if (['ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyD', 'Enter'].includes(e.code)) {
                e.preventDefault();
            }
        });
        
        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
            this.keyPressed[e.code] = false;
        });
    }
    
    isDown(code) {
        return this.keys[code] === true;
    }
    
    isPressed(code) {
        const pressed = this.keyPressed[code];
        // Reset after reading
        if (pressed) this.keyPressed[code] = false;
        return pressed;
    }
    
    // Player movement
    isLeft() {
        return this.isDown('ArrowLeft') || this.isDown('KeyA');
    }
    
    isRight() {
        return this.isDown('ArrowRight') || this.isDown('KeyD');
    }
    
    isShoot() {
        return this.isPressed('Space');
    }
    
    isEnter() {
        return this.isPressed('Enter');
    }
    
    // Clear all input (used on state changes)
    clear() {
        this.keys = {};
        this.keyPressed = {};
    }
}
