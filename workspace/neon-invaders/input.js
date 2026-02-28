// Input handling system
export class InputHandler {
  constructor() {
    this.keys = new Set();
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDown = false;
    this.mousePressed = false; // Single frame press
    
    this.bindEvents();
  }
  
  bindEvents() {
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      // Prevent scrolling with arrow keys and space
      if (['ArrowLeft', 'ArrowRight', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        e.preventDefault();
      }
    });
    
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    
    // Mouse events
    window.addEventListener('mousemove', (e) => {
      const rect = e.target.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    });
    
    window.addEventListener('mousedown', (e) => {
      this.mouseDown = true;
      this.mousePressed = true;
    });
    
    window.addEventListener('mouseup', () => {
      this.mouseDown = false;
    });
    
    // Reset mouse press each frame (called by game loop)
    window.addEventListener('tick', () => {
      this.mousePressed = false;
    });
  }
  
  isPressed(key) {
    return this.keys.has(key);
  }
  
  isAnyKeyDown() {
    return this.keys.size > 0;
  }
  
  // Check for left/right movement
  getHorizontalInput() {
    let dir = 0;
    if (this.isPressed('ArrowLeft') || this.isPressed('KeyA')) dir -= 1;
    if (this.isPressed('ArrowRight') || this.isPressed('KeyD')) dir += 1;
    return dir;
  }
  
  // Check for shooting
  isShooting() {
    return this.isPressed('Space') || this.isPressed('KeyZ') || this.mousePressed;
  }
  
  // Check for pause
  isPausePressed() {
    return this.isPressed('Escape') || this.isPressed('KeyP');
  }
  
  // Check for menu navigation
  isStartPressed() {
    return this.isPressed('Enter') || this.isPressed('Space') || this.mousePressed;
  }
  
  // Get mouse position relative to canvas
  getMousePosition(canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (this.mouseX / rect.width) * canvas.width,
      y: (this.mouseY / rect.height) * canvas.height
    };
  }
  
  // Cleanup
  destroy() {
    // Event listeners are global, so we don't remove them
    // In a production game, you'd want proper cleanup
  }
}
