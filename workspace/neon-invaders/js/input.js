// Keyboard Input Handler

export class InputHandler {
    constructor() {
        this.keys = new Set();
        this.keyDownCallbacks = new Map();
        this.keyUpCallbacks = new Map();
        
        this.bindEvents();
    }
    
    bindEvents() {
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
    }
    
    onKeyDown(e) {
        const key = e.code;
        if (!this.keys.has(key)) {
            this.keys.add(key);
            // Trigger callbacks for this key
            if (this.keyDownCallbacks.has(key)) {
                this.keyDownCallbacks.get(key)();
            }
        }
        // Prevent default for game keys
        if (['ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyD', 'Enter'].includes(key)) {
            e.preventDefault();
        }
    }
    
    onKeyUp(e) {
        const key = e.code;
        this.keys.delete(key);
        // Trigger callbacks for this key
        if (this.keyUpCallbacks.has(key)) {
            this.keyUpCallbacks.get(key)();
        }
    }
    
    isPressed(key) {
        return this.keys.has(key);
    }
    
    isAnyPressed(keys) {
        return keys.some(k => this.keys.has(k));
    }
    
    onKeyPress(key, callback) {
        this.keyDownCallbacks.set(key, callback);
    }
    
    onKeyRelease(key, callback) {
        this.keyUpCallbacks.set(key, callback);
    }
    
    // Convenience methods for common game controls
    isLeft() {
        return this.isPressed('ArrowLeft') || this.isPressed('KeyA');
    }
    
    isRight() {
        return this.isPressed('ArrowRight') || this.isPressed('KeyD');
    }
    
    isShoot() {
        return this.isPressed('Space');
    }
    
    isStart() {
        return this.isPressed('Enter');
    }
    
    // Reset all keys (useful for state transitions)
    reset() {
        this.keys.clear();
    }
    
    // Get all currently pressed keys
    getPressedKeys() {
        return Array.from(this.keys);
    }
}

// Export a singleton instance
export const input = new InputHandler();