// Neon Invaders - Input Handler
// Keyboard input management with smooth key tracking

export class InputHandler {
  constructor() {
    this.keys = new Set();
    this.keyPressed = new Map(); // Track single-press events
    
    this.bindEvents();
  }

  bindEvents() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  onKeyDown(e) {
    // Prevent default for game keys
    if (['ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyD', 'Enter'].includes(e.code)) {
      e.preventDefault();
    }
    
    this.keys.add(e.code);
    
    // Track single press (for actions that should only trigger once per press)
    if (!this.keyPressed.get(e.code)) {
      this.keyPressed.set(e.code, true);
    }
  }

  onKeyUp(e) {
    this.keys.delete(e.code);
    this.keyPressed.delete(e.code);
  }

  // Check if a key is currently held down
  isDown(code) {
    return this.keys.has(code);
  }

  // Check if a key was just pressed this frame
  wasPressed(code) {
    const pressed = this.keyPressed.get(code);
    if (pressed) {
      this.keyPressed.delete(code); // Consume the press
    }
    return pressed;
  }

  // Get horizontal movement direction (-1, 0, or 1)
  getHorizontal() {
    let dir = 0;
    if (this.isDown('ArrowLeft') || this.isDown('KeyA')) dir -= 1;
    if (this.isDown('ArrowRight') || this.isDown('KeyD')) dir += 1;
    return dir;
  }

  // Check for shoot action (space bar, single press)
  isShooting() {
    return this.wasPressed('Space');
  }

  // Check for menu/start action
  isStarting() {
    return this.wasPressed('Enter');
  }

  // Reset all input state (useful for state transitions)
  reset() {
    this.keys.clear();
    this.keyPressed.clear();
  }

  // Clean up event listeners
  destroy() {
    // Note: In a real game, you might want to remove listeners
    // For simplicity, we leave them attached
  }
}

// Export a singleton instance for convenience
export const input = new InputHandler();
