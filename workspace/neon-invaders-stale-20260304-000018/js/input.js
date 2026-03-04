// Keyboard input handler

class InputHandler {
    constructor() {
        this.keys = {};
        this.justPressed = {};
        this.justReleased = {};
        
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    }
    
    handleKeyDown(e) {
        if (!this.keys[e.code]) {
            this.justPressed[e.code] = true;
        }
        this.keys[e.code] = true;
    }
    
    handleKeyUp(e) {
        this.keys[e.code] = false;
        this.justReleased[e.code] = true;
    }
    
    isDown(code) {
        return this.keys[code] === true;
    }
    
    isJustPressed(code) {
        if (this.justPressed[code]) {
            this.justPressed[code] = false;
            return true;
        }
        return false;
    }
    
    isJustReleased(code) {
        if (this.justReleased[code]) {
            this.justReleased[code] = false;
            return true;
        }
        return false;
    }
    
    // Check if any key from a list is pressed
    isAnyDown(codes) {
        return codes.some(code => this.keys[code]);
    }
    
    // Check if any key from a list was just pressed
    isAnyJustPressed(codes) {
        return codes.some(code => this.isJustPressed(code));
    }
}

export default InputHandler;