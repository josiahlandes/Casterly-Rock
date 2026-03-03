// Neon Invaders - Collision Detection
// Simple AABB (Axis-Aligned Bounding Box) collision system

export class Collision {
  // Check if two rectangles overlap
  static aabb(rect1, rect2) {
    return (
      rect1.x < rect2.x + rect2.width &&
      rect1.x + rect1.width > rect2.x &&
      rect1.y < rect2.y + rect2.height &&
      rect1.y + rect1.height > rect2.y
    );
  }

  // Check if a point is inside a rectangle
  static pointInRect(px, py, rect) {
    return (
      px >= rect.x &&
      px <= rect.x + rect.width &&
      py >= rect.y &&
      py <= rect.y + rect.height
    );
  }

  // Create a rectangle from center point and dimensions
  static fromCenter(cx, cy, width, height) {
    return {
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      centerX: cx,
      centerY: cy
    };
  }

  // Get the center point of a rectangle
  static getCenter(rect) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
  }

  // Check if a circle intersects with a rectangle
  static circleRect(cx, cy, radius, rect) {
    // Find the closest point on the rectangle to the circle center
    const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
    
    // Calculate distance from circle center to closest point
    const dx = cx - closestX;
    const dy = cy - closestY;
    
    return (dx * dx + dy * dy) <= (radius * radius);
  }

  // Check if two circles intersect
  static circleCircle(c1, c2) {
    const dx = c1.x - c2.x;
    const dy = c1.y - c2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance <= (c1.radius + c2.radius);
  }

  // Clip a rectangle to screen bounds
  static clipToScreen(rect, screenWidth, screenHeight) {
    return {
      x: Math.max(0, Math.min(rect.x, screenWidth)),
      y: Math.max(0, Math.min(rect.y, screenHeight)),
      width: Math.max(0, Math.min(rect.width, screenWidth - rect.x)),
      height: Math.max(0, Math.min(rect.height, screenHeight - rect.y))
    };
  }

  // Check if a rectangle is completely outside screen bounds
  static isOffScreen(rect, screenWidth, screenHeight) {
    return (
      rect.x > screenWidth ||
      rect.x + rect.width < 0 ||
      rect.y > screenHeight ||
      rect.y + rect.height < 0
    );
  }
}

export default Collision;
